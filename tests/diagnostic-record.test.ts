import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DiagnosticRecord } from '../src/infra/contracts.ts'
import {
  appendDiagnosticRecord,
  diagnosticRecordForError,
  diagnosticCorrelationKey,
  readDiagnosticRecords,
} from '../src/infra/diagnostic-record.ts'
import { workItemKey } from '../src/infra/work-item-identity.ts'
import { attachWorkItemDiagnostics } from '../src/workflow/diagnostic-projection.ts'

const workItem = { provider: 'github', instance: 'github.com', container: 'ai-daming/clickvibe', id: '136' }

test('DiagnosticRecord shares the JSONL transport and is indexed by source plus correlationId', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostic-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const record: DiagnosticRecord = {
    schemaVersion: 1,
    diagnosticId: 'diagnostic-1',
    recordType: 'diagnostic',
    source: 'github-gateway',
    workflow: { workItem },
    operation: 'issue-contract-refresh',
    classification: 'provider-error',
    message: 'upstream unavailable',
    stack: 'stack',
    correlationId: 'request-7',
    rawArtifact: null,
    occurredAt: '2026-09-03T00:00:00Z',
  }
  await appendDiagnosticRecord(root, record, 1024 * 1024)
  assert.equal(diagnosticCorrelationKey(record), 'github-gateway:request-7')
  assert.deepEqual(await readDiagnosticRecords(root, workItem), [record])
  const stored = await readFile(join(root, 'work-items', workItemKey(workItem), 'diagnostics.jsonl'), 'utf8')
  assert.equal(stored, `${JSON.stringify(record)}\n`)
})

test('unknown DiagnosticRecord schema is ignored by the active projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostic-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await appendDiagnosticRecord(
    root,
    {
      schemaVersion: 1,
      diagnosticId: 'diagnostic-1',
      recordType: 'diagnostic',
      source: 'clickvibe',
      workflow: { workItem },
      operation: 'test',
      classification: 'test',
      message: 'visible',
      stack: null,
      correlationId: null,
      rawArtifact: null,
      occurredAt: '2026-09-03T00:00:00Z',
    },
    1024 * 1024,
  )
  const path = join(root, 'work-items', workItemKey(workItem), 'diagnostics.jsonl')
  await import('node:fs/promises').then(({ appendFile }) =>
    appendFile(path, `${JSON.stringify({ schemaVersion: 2, recordType: 'diagnostic', message: 'future' })}\n`),
  )
  assert.equal((await readDiagnosticRecords(root, workItem)).length, 1)
})

test('workflow projection exposes Work Item diagnostics to the panel consumer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostic-projection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = diagnosticRecordForError({
    workItem,
    operation: 'read-current-contract',
    classification: 'corrupt-bundle',
    error: new Error('raw hash mismatch'),
    occurredAt: '2026-09-03T00:00:00Z',
  })
  await appendDiagnosticRecord(root, record, 1024 * 1024)
  const [projected] = await attachWorkItemDiagnostics(
    [{ url: 'https://github.com/ai-daming/clickvibe/issues/136' }],
    root,
  )
  assert.deepEqual(projected.diagnostics, [record])
})
