import { attachWorkItemDiagnostics } from '../src/workflow/diagnostic-projection.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCommand } from '../src/infra/runtime.ts'
import { readDiagnosticRecords } from '../src/infra/diagnostic-record.ts'
import { classifyShellFailure, safeShellOutput } from '../src/infra/shell-failure.ts'

const item = { provider: 'github', instance: 'github.com', container: 'fixture/shell', id: '170' }
const result = (extra = {}) => ({
  exitCode: null,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 100,
  stdout: { text: '' },
  stderr: { text: '' },
  ...extra,
})

test('Git diagnostics retain fixed failure fragments, never path or credential text', () => {
  const safe = "fatal: could not create work tree dir '/private/SECRET': No space left on device"
  const output = safeShellOutput({ text: `token=SECRET\n${safe}\n` }, 'worktree-add')
  assert.equal(output.text, 'fatal: [details omitted]: No space left on device')
  assert.equal(output.omitted, true)
  assert.equal(output.truncated, false)
  for (const operation of ['foreground', 'worktree-custom', 'agent'])
    assert.equal(safeShellOutput({ text: safe }, operation).text, '')
  for (const text of ['SECRET', `${safe} SECRET`, '\u001b[31m' + safe, 'token=No space left on device'])
    assert.equal(safeShellOutput({ text }, 'worktree-add').text, '')
  assert.equal(safeShellOutput(undefined, 'worktree-add').available, false)
})

test('safe tails are bounded in bytes and cannot manufacture a line at the truncation boundary', () => {
  const line = 'fatal: not a git repository (or any of the parent directories): .git'
  const output = safeShellOutput({ text: `${line}\n`.repeat(200) }, 'worktree-common-dir')
  assert.ok(output.text.includes(line))
  assert.ok(Buffer.byteLength(output.text) <= 4096)
  assert.equal(output.truncated, true)
  assert.equal(output.omitted, true)
  assert.equal(safeShellOutput({ text: '密'.repeat(5000) + line }, 'worktree-common-dir').text, '')
  assert.equal(safeShellOutput({ text: line, truncated: true }, 'worktree-common-dir').truncated, true)
})

test('real Git failure reaches diagnostic text and panel without exposing the working directory', async (t) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-shell-real-SECRET-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        try {
          await exec('git', ['rev-parse', '--git-common-dir'], {
            cwd: root,
            env: { PATH: process.env.PATH, HOME: root, LC_ALL: 'C', GIT_CEILING_DIRECTORIES: root },
          })
          throw new Error('expected Git failure')
        } catch (error) {
          const e = error as { code: number; stdout: string; stderr: string }
          assert.equal(e.code, 128)
          return result({ exitCode: e.code, stdout: { text: e.stdout }, stderr: { text: e.stderr } })
        }
      },
    },
  }
  await assert.rejects(
    runCommand(ctx as never, 'git rev-parse --git-common-dir', {
      diagnostic: { operation: 'worktree-common-dir', workItem: item, root },
    }),
    /command-failure/,
  )
  const [record] = await readDiagnosticRecords(root, item)
  const raw = await readFile(record.rawArtifact!.path, 'utf8')
  assert.match(JSON.parse(raw).stderr.text, /not a git repository/)
  assert.doesNotMatch(raw, /SECRET/)
  const [view] = await attachWorkItemDiagnostics([{ url: 'https://github.com/fixture/shell/issues/170' }], root)
  assert.match(view.diagnostics[0].details ?? '', /not a git repository/)
  assert.doesNotMatch(view.diagnostics[0].details ?? '', /SECRET/)
})

test('two bounded safe tails remain readable when their JSON envelope exceeds 8 KiB', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-shell-envelope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const line = 'fatal: not a git repository (or any of the parent directories): .git'
  const text = `${line}\n`.repeat(200)
  const ctx = {
    shell: { resolve: (spec: unknown) => spec, run: async () => result({ stdout: { text }, stderr: { text } }) },
  }
  await assert.rejects(
    runCommand(ctx as never, 'git rev-parse HEAD', {
      diagnostic: { operation: 'worktree-head', root, workItem: item },
    }),
  )
  const [record] = await readDiagnosticRecords(root, item)
  const raw = await readFile(record.rawArtifact!.path)
  assert.ok(raw.length > 8192)
  const detail = JSON.parse(raw.toString())
  assert.ok(Buffer.byteLength(detail.stdout.text) <= 4096)
  assert.ok(Buffer.byteLength(detail.stderr.text) <= 4096)
  const [view] = await attachWorkItemDiagnostics([{ url: 'https://github.com/fixture/shell/issues/170' }], root)
  assert.match(view.diagnostics[0].details ?? '', /not a git repository/)
  assert.match(view.diagnostics[0].details ?? '', /截断: 是/)
})

test('first-cause shell classification does not infer timeout from a missing exit code', () => {
  assert.equal(classifyShellFailure(result()), 'unknown')
  assert.equal(classifyShellFailure(result({ timedOut: 'yes' }) as never), 'unknown')
  assert.equal(classifyShellFailure(result({ signal: 'not-a-signal' })), 'unknown')
  assert.equal(classifyShellFailure(result({ timedOut: true, signal: 'SIGTERM' })), 'timeout')
  assert.equal(classifyShellFailure(result({ aborted: true, signal: 'SIGTERM' })), 'abort')
  assert.equal(classifyShellFailure(result({ signal: 'SIGKILL' })), 'signal')
  assert.equal(classifyShellFailure(result({ timedOut: true, aborted: true })), 'unknown')
  assert.equal(classifyShellFailure(result({ exitCode: 0, timedOut: true })), 'unknown')
  assert.equal(classifyShellFailure(result({ exitCode: 2 })), 'command-failure')
})

test('null exit preserves safe cause evidence through the real diagnostic reader', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-shell-cause-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keys: string[] = []
  for (const output of ['token=DO_NOT_PUBLISH', 'different dynamic text']) {
    const ctx = {
      shell: {
        resolve: (spec: unknown) => spec,
        run: async () => result({ timedOut: true, signal: 'SIGTERM', stdout: { text: output } }),
      },
    }
    await assert.rejects(
      runCommand(ctx as never, 'git status', {
        timeoutMs: 200,
        diagnostic: { operation: 'worktree-observe', workItem: item, root },
      }),
      (error: unknown) => {
        const value = error as Error & { failureKey: string }
        assert.match(value.message, /timeout/)
        assert.doesNotMatch(value.message, /DO_NOT_PUBLISH/)
        keys.push(value.failureKey)
        return true
      },
    )
  }
  assert.equal(keys[0], keys[1])
  assert.ok(keys[0])
  const records = await readDiagnosticRecords(root, item)
  assert.equal(records.length, 2)
  const record = records[0]
  assert.equal(record.classification, 'timeout')
  assert.equal(record.operation, 'worktree-observe')
  assert.ok(record.rawArtifact)
  const raw = await readFile(record.rawArtifact.path, 'utf8')
  assert.doesNotMatch(raw, /DO_NOT_PUBLISH/)
  const detail = JSON.parse(raw)
  assert.equal(detail.signal, 'SIGTERM')
  assert.equal(detail.effectiveTimeoutMs, 100)
  assert.equal(detail.requestedTimeoutMs, 200)
  assert.equal(detail.stdout.omitted, true)
  assert.ok(detail.durationMs >= 0)
  const [view] = await attachWorkItemDiagnostics([{ url: 'https://github.com/fixture/shell/issues/170' }], root)
  assert.match(view.diagnostics[0].details ?? '', /SIGTERM/)
  assert.match(view.diagnostics[0].details ?? '', /100/)
  assert.doesNotMatch(view.diagnostics[0].details ?? '', /DO_NOT_PUBLISH/)
})

test('resolve rejection is host failure and successful stdout remains unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-shell-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostic = { operation: 'worktree-observe', workItem: item, root }
  await assert.rejects(
    runCommand(
      {
        shell: {
          resolve() {
            throw new Error('token=SECRET')
          },
        },
      } as never,
      'git status',
      { diagnostic },
    ),
    /host-shell-failure/,
  )
  const records = await readDiagnosticRecords(root, item)
  assert.equal(records.length, 1)
  assert.doesNotMatch(JSON.stringify(records), /SECRET/)
  assert.equal(
    await runCommand(
      {
        shell: {
          resolve: (spec: unknown) => spec,
          run: async () => result({ exitCode: 0, stdout: { text: ' ok\n' } }),
        },
      } as never,
      'git status',
      { diagnostic },
    ),
    'ok',
  )
  assert.equal((await readDiagnosticRecords(root, item)).length, 1)
})

test('diagnostic rotation retains only artifacts referenced by the two retained segments', async (t) => {
  const { readdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const { diagnosticLogPath } = await import('../src/infra/state-layout.ts')
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-shell-retention-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = { shell: { resolve: (spec: unknown) => spec, run: async () => result({ signal: 'SIGTERM' }) } }
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      runCommand(ctx as never, 'git status', {
        diagnostic: { root, workItem: item, operation: 'worktree-observe', maxBytes: 1 },
      }),
    )
  const records = await readDiagnosticRecords(root, item)
  assert.equal(records.length, 2)
  const files = await readdir(join(dirname(diagnosticLogPath(root, item)), 'artifacts'))
  assert.equal(files.length, 2)
  for (const record of records) assert.ok((await readFile(record.rawArtifact!.path)).length > 0)
})
