import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { diagnosticLogPath } from './state-layout.ts'
import { assertLegacyStateWriteAllowed } from './v02-generation-fence.ts'

export const DEFAULT_DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024

const queueSymbol = Symbol.for('clickvibe.diagnostic-log-queues')
const globalQueues = globalThis as typeof globalThis & {
  [queueSymbol]?: Map<string, Promise<unknown>>
}
const existingQueues = globalQueues[queueSymbol]
const logQueues = existingQueues ?? new Map<string, Promise<unknown>>()
if (!existingQueues) {
  globalQueues[queueSymbol] = logQueues
}

function enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = logQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  logQueues.set(path, current)
  void current
    .finally(() => {
      if (logQueues.get(path) === current) logQueues.delete(path)
    })
    .catch(() => undefined)
  return current
}

function rotatedPath(path: string): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.1.jsonl` : `${path}.1`
}

function configuredMaxBytes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DIAGNOSTIC_MAX_BYTES
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** Serialize size-check, one-segment rotation, and append for one diagnostic stream. */
export function appendDiagnosticLine(
  root: string,
  workflowKey: unknown,
  line: string,
  maxBytes: unknown | Promise<unknown>,
): Promise<void> {
  assertLegacyStateWriteAllowed(root)
  const path = diagnosticLogPath(root, workflowKey)
  return enqueue(path, async () => {
    assertLegacyStateWriteAllowed(root)
    const limit = configuredMaxBytes(await maxBytes)
    const record = `${line}\n`
    await mkdir(dirname(path), { recursive: true })
    const existingBytes = await fileSize(path)
    if (existingBytes > 0 && existingBytes + Buffer.byteLength(record, 'utf8') > limit) {
      assertLegacyStateWriteAllowed(root)
      await rm(rotatedPath(path), { force: true })
      assertLegacyStateWriteAllowed(root)
      await rename(path, rotatedPath(path))
    }
    assertLegacyStateWriteAllowed(root)
    await appendFile(path, record, 'utf8')
  })
}

/** Drain the current stream, including writes queued while an earlier append was running. */
export async function waitForDiagnosticLines(root: string, workflowKey: unknown): Promise<void> {
  const path = diagnosticLogPath(root, workflowKey)
  while (logQueues.has(path)) {
    await logQueues.get(path)?.catch(() => undefined)
  }
}
