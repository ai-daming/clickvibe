import { recoveryStateRoot } from './recovery-layout.ts'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { diagnosticLogPath } from './state-layout.ts'
import { assertActiveStateWriteAllowed } from './v02-generation-fence.ts'

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
  options: { generation?: 'v0.2'; artifact?: { path: string; bytes: string } } = {},
): Promise<void> {
  if (options.generation !== 'v0.2' || root === recoveryStateRoot(dirname(dirname(root))))
    assertActiveStateWriteAllowed(root)
  const path = diagnosticLogPath(root, workflowKey)
  return enqueue(path, async () => {
    if (options.generation !== 'v0.2' || root === recoveryStateRoot(dirname(dirname(root))))
      assertActiveStateWriteAllowed(root)
    const limit = configuredMaxBytes(await maxBytes)
    const record = `${line}\n`
    await mkdir(dirname(path), { recursive: true })
    const existingBytes = await fileSize(path)
    if (existingBytes > 0 && existingBytes + Buffer.byteLength(record, 'utf8') > limit) {
      if (options.generation !== 'v0.2' || root === recoveryStateRoot(dirname(dirname(root))))
        assertActiveStateWriteAllowed(root)
      await rm(rotatedPath(path), { force: true })
      if (options.generation !== 'v0.2' || root === recoveryStateRoot(dirname(dirname(root))))
        assertActiveStateWriteAllowed(root)
      await rename(path, rotatedPath(path))
    }
    if (options.generation !== 'v0.2' || root === recoveryStateRoot(dirname(dirname(root))))
      assertActiveStateWriteAllowed(root)
    const artifact = options.artifact
    if (artifact) {
      if (dirname(artifact.path) !== join(dirname(path), 'artifacts') || !/shell-[a-f0-9-]+\.json$/.test(artifact.path))
        throw new Error('invalid diagnostic artifact path')
      await mkdir(dirname(artifact.path), { recursive: true })
      await writeFile(artifact.path, artifact.bytes, { flag: 'wx', mode: 0o600 })
    }
    try {
      await appendFile(path, record, 'utf8')
    } catch (error) {
      if (artifact) await rm(artifact.path, { force: true })
      throw error
    }
    if (artifact) await collectShellArtifacts(path)
  })
}

/** Drain the current stream, including writes queued while an earlier append was running. */
export async function waitForDiagnosticLines(root: string, workflowKey: unknown): Promise<void> {
  const path = diagnosticLogPath(root, workflowKey)
  while (logQueues.has(path)) {
    await logQueues.get(path)?.catch(() => undefined)
  }
}

/** Artifact publication and collection share the stream's append/rotation queue. */
async function collectShellArtifacts(path: string): Promise<void> {
  const referenced = new Set<string>()
  for (const stream of [path, rotatedPath(path)]) {
    let text: string
    try {
      text = await readFile(stream, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line)
        if (typeof record.rawArtifact?.path === 'string') referenced.add(record.rawArtifact.path)
      } catch {
        return
      } // Corrupt retained evidence cannot authorize deletion.
    }
  }
  const directory = join(dirname(path), 'artifacts')
  for (const name of await readdir(directory)) {
    const file = join(directory, name)
    if (/^shell-[a-f0-9-]+\.json$/.test(name) && !referenced.has(file)) await rm(file, { force: true })
  }
}
