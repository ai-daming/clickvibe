import { randomUUID } from 'node:crypto'

export const runtimeIdentity = Object.freeze({
  runtimeInstanceId: randomUUID(),
  pid: process.pid,
  loadedAt: new Date().toISOString(),
  modulePath: import.meta.url,
})

/** One structured diagnostic stream correlates task ownership across plugin instances. */
export function logTaskDiagnostic(event: string, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      source: 'clickvibe',
      event,
      at: new Date().toISOString(),
      ...runtimeIdentity,
      ...fields,
    }),
  )
}
