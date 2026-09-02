import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch, remotePush } from '../src/infra/remote-git.ts'

function recordingShell(exitCode = 0, outputFor: (command: string) => string = () => 'out\n') {
  const commands: Array<{ command: string; workdir?: string; timeoutMs?: number }> = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string; workdir?: string; timeoutMs?: number }) => {
        commands.push(spec)
        return { exitCode, stdout: { text: outputFor(spec.command) }, stderr: { text: '' } }
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

test('remotePush freezes an exact oid and performs one authoritative readback', async () => {
  const oid = 'a'.repeat(40)
  const push = recordingShell(0, (command) =>
    command.startsWith('git ls-remote') ? `${oid}\trefs/heads/feature\n` : 'pushed\n',
  )
  const persisted: string[] = []
  await remotePush(push.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/wt',
    prepare: async () => ({
      operationKind: 'push',
      destinationRef: 'refs/heads/feature',
      expectedOid: oid,
      expectedRemoteOid: null,
    }),
    persistAttempt: async (attempt) => {
      persisted.push(attempt.status)
    },
    settleAttempt: async (attempt) => {
      persisted.push(attempt.status)
    },
  })
  assert.equal(push.commands[0].command, `git push origin '${oid}:refs/heads/feature'`)
  assert.equal(push.commands[1].command, "git ls-remote --heads origin 'refs/heads/feature'")
  assert.deepEqual(persisted, ['prepared', 'confirmed'])

  const forceOid = 'b'.repeat(40)
  const leaseOid = 'c'.repeat(40)
  const force = recordingShell(0, (command) =>
    command.startsWith('git ls-remote') ? `${forceOid}\trefs/heads/main\n` : 'pushed\n',
  )
  await remotePush(force.ctx, {
    repoKey: 'ai-daming/clickvibe',
    workdir: '/wt',
    prepare: async () => ({
      operationKind: 'force-with-lease',
      destinationRef: 'refs/heads/main',
      expectedOid: forceOid,
      expectedRemoteOid: leaseOid,
    }),
    persistAttempt: async () => undefined,
    settleAttempt: async () => undefined,
  })
  assert.equal(
    force.commands[0].command,
    `git push --force-with-lease='refs/heads/main:${leaseOid}' origin '${forceOid}:refs/heads/main'`,
  )
  assert.equal(force.commands[1].command, "git ls-remote --heads origin 'refs/heads/main'")
})

test('non-zero exits reject through the shared runCommand semantics', async () => {
  const failing = recordingShell(128)
  await assert.rejects(
    remoteFetch(failing.ctx, { repoKey: 'o/r', workdir: '/repo', timeoutMs: 30_000 }),
    /命令退出码 128/,
  )
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
  assert.equal(
    customRemote.commands[1].command,
    "git for-each-ref --format='%(refname) %(objectname)' refs/remotes/upstream",
  )
})
