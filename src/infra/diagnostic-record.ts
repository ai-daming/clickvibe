/** v0.2 DiagnosticRecord transport and active projection reader. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DiagnosticRecord, WorkItemIdentity } from './contracts.ts'
import { appendDiagnosticLine } from './diagnostic-log-store.ts'
import { diagnosticLogPath } from './state-layout.ts'
import { safeShellOutput } from './shell-failure.ts'

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

/** Only read this producer's bounded, hash-verified artifact under its own Work Item directory. */
export async function readDiagnosticDetails(root: string, record: DiagnosticRecord): Promise<string | undefined> {
  const ref = record.rawArtifact
  if (!ref || ref.kind !== 'diagnostic' || ref.redaction !== 'applied' || !basename(ref.path).startsWith('shell-'))
    return undefined
  const directory = dirname(diagnosticLogPath(root, record.workflow?.workItem))
  const expected = join(directory, 'artifacts', `shell-${record.diagnosticId}.json`)
  if (!/^[a-f0-9-]{36}$/.test(record.diagnosticId) || ref.path !== expected) return '诊断附件路径不匹配，已拒绝读取'
  try {
    if ((await realpath(dirname(expected))) !== join(await realpath(directory), 'artifacts'))
      return '诊断附件目录不匹配'
    if ((await lstat(expected)).isSymbolicLink()) return '诊断附件不可使用符号链接'
    const file = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
    let raw: Buffer
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16384) return '诊断附件类型或大小无效'
      raw = await file.readFile()
    } finally {
      await file.close()
    }
    if (ref.contentHash !== `sha256-v1_${createHash('sha256').update(raw).digest('base64url')}`)
      return '诊断附件哈希校验失败'
    const d = JSON.parse(raw.toString('utf8'))
    const ms = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value} ms` : '未知'
    const time = (value: unknown) =>
      typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '未知'
    const signal = typeof d.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(d.signal) ? d.signal : '未知'
    const output = (value: { text?: string; omitted?: boolean; truncated?: boolean } | undefined) => {
      const safe = safeShellOutput(value, record.operation)
      return `${safe.text || '无安全输出文本'}；省略: ${value?.omitted || safe.omitted ? '是' : '否'}；截断: ${safe.truncated ? '是' : '否'}`
    }
    return [
      `终止信号: ${signal}`,
      `请求超时: ${ms(d.requestedTimeoutMs)}；实际超时: ${ms(d.effectiveTimeoutMs)}`,
      `开始: ${time(d.startedAt)}`,
      `结束: ${time(d.endedAt)}`,
      `耗时: ${ms(d.durationMs)}`,
      `标准输出: ${output(d.stdout)}`,
      `标准错误: ${output(d.stderr)}`,
    ].join('\n')
  } catch {
    return '诊断附件缺失或无法读取；原始错误摘要仍保留'
  }
}
