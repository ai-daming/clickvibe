import { randomUUID } from 'node:crypto'
import { appendDiagnosticLine, DEFAULT_DIAGNOSTIC_MAX_BYTES, waitForDiagnosticLines } from './diagnostic-log-store.ts'
import { loadConfig } from './runtime.ts'
import { stateDir } from './state.ts'

export const runtimeIdentity = Object.freeze({
  runtimeInstanceId: randomUUID(),
  pid: process.pid,
  loadedAt: new Date().toISOString(),
  modulePath: import.meta.url,
})

/** One structured diagnostic stream correlates task ownership across plugin instances. */
export function logTaskDiagnostic(event: string, fields: Record<string, unknown>): void {
  const record = {
    source: 'clickvibe',
    event,
    at: new Date().toISOString(),
    ...runtimeIdentity,
    ...fields,
  }
  const line = JSON.stringify(record)
  console.warn(line)
  const maxBytes = loadConfig()
    .then((config) => config.diagnosticsMaxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES)
    .catch(() => DEFAULT_DIAGNOSTIC_MAX_BYTES)
  void appendDiagnosticLine(stateDir(), fields.workflowKey, line, maxBytes).catch(() => undefined)
}

/** Await best-effort writes before a task releases or deletes its persistence directory. */
export function waitForTaskDiagnosticPersistence(workflowKey: unknown): Promise<void> {
  return waitForDiagnosticLines(stateDir(), workflowKey)
}
