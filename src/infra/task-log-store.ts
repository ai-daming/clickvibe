import { appendFile, link, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decodeLiveLogLine, encodeLiveLogEvent, type LiveLogEvent } from './live-output.ts'
import { taskLogPath, type WorkflowStorageIdentity } from './state-layout.ts'
import { assertLegacyStateWriteAllowed } from './v02-generation-fence.ts'

export type TaskLogKind = 'dev' | 'review'
export type TaskExitStatus = 'done' | 'failed' | 'stopped' | 'timed_out'

export interface TaskLogRecord {
  ts: string
  level: 'info' | 'error'
  kind: string
  taskId: string
  sequence: number
  source: 'agent' | 'clickvibe'
  line: string
  event?: LiveLogEvent
  wireLine?: string
  status?: TaskExitStatus
  exitCode?: number | null
}

export interface TaskMetrics {
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  status: TaskExitStatus | 'running' | null
  exitCode: number | null
}

export interface TaskLogRead {
  records: TaskLogRecord[]
  encodedLines: string[]
  lines: string[]
  events: LiveLogEvent[]
  metrics: TaskMetrics
}

const logQueues = new Map<string, Promise<unknown>>()

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

function taskRecord(
  taskId: string,
  sequence: number,
  encodedLine: string,
  options: AppendTaskLogOptions,
): TaskLogRecord {
  const event = decodeLiveLogLine(encodedLine)
  return {
    ts: options.ts ?? new Date().toISOString(),
    level: options.level ?? (options.status === 'failed' || options.status === 'timed_out' ? 'error' : 'info'),
    kind: event.kind,
    taskId,
    sequence,
    source: event.source === 'system' ? 'clickvibe' : 'agent',
    line: event.text,
    event,
    ...(encodedLine === encodeLiveLogEvent(event) ? { wireLine: encodedLine } : {}),
    ...(options.status ? { status: options.status, exitCode: options.exitCode ?? null } : {}),
  }
}

function isTaskLogRecord(value: unknown): value is TaskLogRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<TaskLogRecord>
  return (
    typeof record.ts === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.taskId === 'string' &&
    Number.isSafeInteger(record.sequence) &&
    (record.source === 'agent' || record.source === 'clickvibe') &&
    typeof record.line === 'string'
  )
}

function recordEvent(record: TaskLogRecord): LiveLogEvent {
  if (record.event && typeof record.event.text === 'string') return record.event
  return record.source === 'clickvibe'
    ? { source: 'system', kind: 'system', text: record.line }
    : { source: 'agent', kind: 'text', text: record.line }
}

function aggregateMetrics(records: TaskLogRecord[]): TaskMetrics {
  const first = records[0]
  const final = [...records].reverse().find((record) => record.status)
  const started = first ? Date.parse(first.ts) : Number.NaN
  const ended = final ? Date.parse(final.ts) : Number.NaN
  return {
    startedAt: first?.ts ?? null,
    endedAt: final?.ts ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
    status: final?.status ?? (first ? 'running' : null),
    exitCode: final?.exitCode ?? null,
  }
}

export interface AppendTaskLogOptions {
  ts?: string
  level?: 'info' | 'error'
  status?: TaskExitStatus
  exitCode?: number | null
}

export async function startTaskLog(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
): Promise<void> {
  assertLegacyStateWriteAllowed(root)
  const path = taskLogPath(root, workflow, kind, taskId)
  await enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, '', { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  })
}

export async function appendTaskLog(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
  sequence: number,
  encodedLine: string,
  options: AppendTaskLogOptions = {},
): Promise<void> {
  assertLegacyStateWriteAllowed(root)
  const path = taskLogPath(root, workflow, kind, taskId)
  const record = taskRecord(taskId, sequence, encodedLine, options)
  await enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  })
}

export async function readTaskLog(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
): Promise<TaskLogRead> {
  const path = taskLogPath(root, workflow, kind, taskId)
  try {
    return await enqueue(path, async () => {
      const raw = await readFile(path, 'utf8')
      const records: TaskLogRecord[] = []
      for (const line of raw.split('\n')) {
        if (line === '') continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isTaskLogRecord(parsed)) records.push(parsed)
        } catch {
          // A crash may leave one partial trailing line; prior valid records remain readable.
        }
      }
      records.sort((a, b) => a.sequence - b.sequence)
      const events = records.map(recordEvent)
      return {
        records,
        events,
        lines: events.map((event) => event.text),
        encodedLines: records.map((record, index) => record.wireLine ?? events[index].text),
        metrics: aggregateMetrics(records),
      }
    })
  } catch {
    return {
      records: [],
      events: [],
      lines: [],
      encodedLines: [],
      metrics: aggregateMetrics([]),
    }
  }
}

export async function listTaskIds(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
): Promise<string[]> {
  const directory = dirname(taskLogPath(root, workflow, kind, 'probe'))
  try {
    const entries = await readdir(directory)
    return entries
      .filter((entry) => entry.endsWith('.jsonl') && entry.includes('--'))
      .map((entry) => entry.slice(entry.indexOf('--') + 2, -'.jsonl'.length))
      .reverse()
  } catch {
    return []
  }
}

export async function appendTaskLogNext(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
  encodedLine: string,
  options: AppendTaskLogOptions = {},
): Promise<void> {
  assertLegacyStateWriteAllowed(root)
  const path = taskLogPath(root, workflow, kind, taskId)
  await enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    let sequence = 1
    try {
      const raw = await readFile(path, 'utf8')
      for (const line of raw.split('\n')) {
        try {
          const record: unknown = JSON.parse(line)
          if (isTaskLogRecord(record)) sequence = Math.max(sequence, record.sequence + 1)
        } catch {
          // Ignore a trailing partial record when continuing a best-effort log.
        }
      }
    } catch {
      // Missing task file is created by appendFile.
    }
    await appendFile(path, `${JSON.stringify(taskRecord(taskId, sequence, encodedLine, options))}\n`, 'utf8')
  })
}

export async function migrateLegacyLog(
  root: string,
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
  legacyPath: string,
  timestamp: string,
): Promise<void> {
  assertLegacyStateWriteAllowed(root)
  const destination = taskLogPath(root, workflow, kind, taskId)
  const raw = await readFile(legacyPath, 'utf8')
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const records = lines.map((line, index) => taskRecord(taskId, index + 1, line, { ts: timestamp }))
  const serialized = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
  await mkdir(dirname(destination), { recursive: true })
  try {
    const existing = await readFile(destination, 'utf8')
    if (existing !== serialized) throw new Error('existing task log differs from legacy source')
    await rm(legacyPath)
    await rmdir(join(legacyPath, '..')).catch(() => undefined)
    return
  } catch {
    // Destination is absent or incomplete; complete it through an exclusive link.
  }
  const temporary = `${destination}.migrating`
  await writeFile(temporary, serialized, 'utf8')
  try {
    await link(temporary, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(destination, 'utf8')
    if (existing !== (await readFile(temporary, 'utf8'))) throw error
  }
  await rm(temporary, { force: true })
  await rm(legacyPath)
  await rmdir(join(legacyPath, '..')).catch(() => undefined)
}
