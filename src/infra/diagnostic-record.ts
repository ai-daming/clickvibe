/** v0.2 DiagnosticRecord transport and active projection reader. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DiagnosticRecord, WorkItemIdentity } from './contracts.ts'
import { appendDiagnosticLine } from './diagnostic-log-store.ts'
import { diagnosticLogPath } from './state-layout.ts'

export function diagnosticCorrelationKey(record: Pick<DiagnosticRecord, 'source' | 'correlationId'>): string | null {
  return record.correlationId === null ? null : `${record.source}:${record.correlationId}`
}

export function appendDiagnosticRecord(root: string, record: DiagnosticRecord, maxBytes: number): Promise<void> {
  return appendDiagnosticLine(root, record.workflow?.workItem ?? record.source, JSON.stringify(record), maxBytes, {
    generation: 'v0.2',
  })
}

export function diagnosticRecordForError(input: {
  workItem: WorkItemIdentity
  operation: string
  classification: string
  error: unknown
  correlationId?: string | null
  rawArtifact?: DiagnosticRecord['rawArtifact']
  occurredAt?: string
}): DiagnosticRecord {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error))
  return {
    schemaVersion: 1,
    diagnosticId: randomUUID(),
    recordType: 'diagnostic',
    source: 'clickvibe',
    workflow: { workItem: input.workItem },
    operation: input.operation,
    classification: input.classification,
    message: error.message,
    stack: error.stack ?? null,
    correlationId: input.correlationId ?? null,
    rawArtifact: input.rawArtifact ?? null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }
}

function isDiagnosticRecord(value: unknown): value is DiagnosticRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<DiagnosticRecord>
  const workflow = record.workflow
  const rawArtifact = record.rawArtifact
  const validWorkflow =
    workflow === null ||
    (typeof workflow === 'object' &&
      workflow !== null &&
      typeof workflow.workItem === 'object' &&
      workflow.workItem !== null &&
      typeof workflow.workItem.provider === 'string' &&
      typeof workflow.workItem.instance === 'string' &&
      typeof workflow.workItem.container === 'string' &&
      typeof workflow.workItem.id === 'string')
  const validArtifact =
    rawArtifact === null ||
    (typeof rawArtifact === 'object' &&
      rawArtifact !== null &&
      typeof rawArtifact.artifactId === 'string' &&
      (rawArtifact.kind === 'issue-snapshot' ||
        rawArtifact.kind === 'log' ||
        rawArtifact.kind === 'diff' ||
        rawArtifact.kind === 'provider-response' ||
        rawArtifact.kind === 'model-output' ||
        rawArtifact.kind === 'diagnostic') &&
      typeof rawArtifact.path === 'string' &&
      /^sha256-v1_[A-Za-z0-9_-]{43}$/.test(rawArtifact.contentHash) &&
      (rawArtifact.redaction === 'none' || rawArtifact.redaction === 'applied'))
  return (
    record.schemaVersion === 1 &&
    record.recordType === 'diagnostic' &&
    typeof record.diagnosticId === 'string' &&
    (record.source === 'clickvibe' || record.source === 'github-gateway' || record.source === 'remote-git') &&
    typeof record.operation === 'string' &&
    typeof record.classification === 'string' &&
    typeof record.message === 'string' &&
    (record.stack === null || typeof record.stack === 'string') &&
    (record.correlationId === null || typeof record.correlationId === 'string') &&
    typeof record.occurredAt === 'string' &&
    validWorkflow &&
    validArtifact
  )
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function readDiagnosticRecords(root: string, workItem: WorkItemIdentity): Promise<DiagnosticRecord[]> {
  const path = diagnosticLogPath(root, workItem)
  const rotated = path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.1.jsonl` : `${path}.1`
  const lines = [...(await readLines(rotated)), ...(await readLines(path))]
  const records: DiagnosticRecord[] = []
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line)
      if (isDiagnosticRecord(value)) records.push(value)
    } catch {
      // A malformed line cannot become active evidence; later valid lines remain readable.
    }
  }
  return records
}
