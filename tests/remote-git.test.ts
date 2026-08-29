import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch, remotePush } from '../src/infra/remote-git.ts'

function recordingShell(exitCode = 0) {
  const commands: Array<{ command: string; workdir?: string; timeoutMs?: number }> = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string; workdir?: string; timeoutMs?: number }) => {
        commands.push(spec)
        return { exitCode, stdout: { text: 'out\n' }, stderr: { text: '' } }
      },
    },
  } as unknown as Context
  return { ctx, commands }
}

test('remoteFetch builds the exact legacy command strings and forwards options', async () => {
  const pruned = recordingShell()
  await remoteFetch(pruned.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/repo',
    timeoutMs: 60_000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/repo' },
  })
  assert.equal(pruned.commands[0].command, 'git fetch origin --prune')
  assert.equal(pruned.commands[0].workdir, '/repo')
  assert.equal(pruned.commands[0].timeoutMs, 60_000)

  const plain = recordingShell()
  await remoteFetch(plain.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/repo',
    timeoutMs: 30_000,
    prune: false,
  })
  assert.equal(plain.commands[0].command, 'git fetch origin')
})

test('remotePush builds the exact legacy push forms', async () => {
  const push = recordingShell()
  await remotePush(push.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/wt',
    timeoutMs: 60_000,
    refspec: "'clickvibe-issue-5'",
  })
  assert.equal(push.commands[0].command, "git push origin 'clickvibe-issue-5'")

  const upstream = recordingShell()
  await remotePush(upstream.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/wt',
    timeoutMs: 120_000,
    refspec: "'feature'",
    setUpstream: true,
  })
  assert.equal(upstream.commands[0].command, "git push --set-upstream origin 'feature'")
})

test('non-zero exits reject through the shared runCommand semantics', async () => {
  const failing = recordingShell(128)
  await assert.rejects(remoteFetch(failing.ctx, { workdir: '/repo', timeoutMs: 30_000 }), /命令退出码 128/)
})

test('coordination identity is carried, never leaked into the command', async () => {
  const recording = recordingShell()
  await remoteFetch(recording.ctx, {
    repoKey: 'ai-daming/clickvibe',
    repositoryId: 'future-binding-id',
    workdir: '/repo',
    timeoutMs: 30_000,
  })
  assert.equal(recording.commands[0].command, 'git fetch origin --prune')
  assert.equal(recording.commands[0].workdir, '/repo')
  assert.equal(recording.commands[0].timeoutMs, 30_000)

  const customRemote = recordingShell()
  await remoteFetch(customRemote.ctx, { repoKey: 'o/r', remote: 'upstream', workdir: '/repo' })
  assert.equal(customRemote.commands[0].command, 'git fetch upstream --prune')
  await remotePush(customRemote.ctx, { repoKey: 'o/r', remote: 'upstream', workdir: '/repo', refspec: "'x'" })
  assert.equal(customRemote.commands[1].command, "git push upstream 'x'")
})
