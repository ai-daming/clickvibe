import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { githubAwareStatus, readJsonBody, readWorktreeHead, runCommand } from '../src/infra/runtime.ts'

function requestWith(chunks: Buffer[], ending: 'end' | 'error' = 'end'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.destroy = (() => req) as never
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit(ending, ending === 'error' ? new Error('socket failed') : undefined)
  })
  return req
}

function shellResult(result: {
  exitCode: number
  stdout: { text: string; truncated?: boolean; spillPath?: string }
  stderr?: { text: string }
}) {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run() {
        return { ...result, stderr: result.stderr ?? { text: '' } }
      },
    },
  }
}

test('JSON body reader handles empty, malformed, socket-error and oversized requests', async () => {
  assert.deepEqual(await readJsonBody(requestWith([])), {})
  assert.deepEqual(await readJsonBody(requestWith([Buffer.from('{"ok":true}')])), { ok: true })
  await assert.rejects(readJsonBody(requestWith([Buffer.from('{broken')])), /malformed JSON body/)
  await assert.rejects(readJsonBody(requestWith([], 'error')), /socket failed/)
  await assert.rejects(readJsonBody(requestWith([Buffer.alloc(2 * 1024 * 1024)])), /request body too large/)
})

test('GitHub-aware status distinguishes success, quota exhaustion and ordinary failures', () => {
  assert.equal(githubAwareStatus({ ok: true }, 201, 422), 201)
  assert.equal(githubAwareStatus({ ok: false, error: 'GitHub 额度已用完,约 10:00 恢复' }), 429)
  assert.equal(githubAwareStatus({ ok: false }, 201, 422), 422)
})

test('command runner preserves failure details and handles bounded spill output', async () => {
  await assert.rejects(
    runCommand(
      shellResult({ exitCode: 2, stdout: { text: 'stdout detail' }, stderr: { text: 'stderr detail' } }) as never,
      'bad',
    ),
    /退出码 2: stderr detail\nstdout detail/,
  )
  await assert.rejects(runCommand(shellResult({ exitCode: 1, stdout: { text: '' } }) as never, 'bad'), /退出码 1$/)
  await assert.rejects(
    runCommand(shellResult({ exitCode: 0, stdout: { text: 'tail', truncated: true } }) as never, 'large'),
    /无 spill 文件/,
  )

  const root = await mkdtemp(join(tmpdir(), 'clickvibe-command-spill-'))
  try {
    const spill = join(root, 'stdout.log')
    await writeFile(spill, ' full output \n')
    assert.equal(
      await runCommand(
        shellResult({ exitCode: 0, stdout: { text: 'tail', truncated: true, spillPath: spill } }) as never,
        'large',
      ),
      'full output',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worktree head reader returns hashes and degrades failures, empty output and exceptions', async () => {
  assert.equal(
    await readWorktreeHead(shellResult({ exitCode: 0, stdout: { text: ' abc123 \n' } }) as never, '/repo'),
    'abc123',
  )
  assert.equal(await readWorktreeHead(shellResult({ exitCode: 0, stdout: { text: '' } }) as never, '/repo'), null)
  assert.equal(await readWorktreeHead(shellResult({ exitCode: 1, stdout: { text: '' } }) as never, '/repo'), null)
  const thrown = {
    shell: {
      resolve() {
        throw new Error('resolve failed')
      },
    },
  }
  assert.equal(await readWorktreeHead(thrown as never, '/repo'), null)
})
