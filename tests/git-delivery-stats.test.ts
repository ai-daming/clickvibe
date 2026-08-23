import assert from 'node:assert/strict'
import test from 'node:test'
import { readDeliveryStats } from '../src/infra/git.ts'

test('delivery stats freeze commits and numstat from the fork point to the anchored head', async () => {
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: { command: string }) {
        commands.push(spec.command)
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.startsWith('git merge-base ')) {
          return { exitCode: 0, stdout: { text: 'base123\n' }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('git log ')) {
          return {
            exitCode: 0,
            stdout: { text: 'abc123\u001f补充测试\ndef456\u001f实现审计\n' },
            stderr: { text: '' },
          }
        }
        if (spec.command.startsWith('git diff --numstat ')) {
          return {
            exitCode: 0,
            stdout: { text: '10\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n3\t0\tsrc/b.ts\n' },
            stderr: { text: '' },
          }
        }
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'unexpected' } }
      },
    },
  }

  const stats = await readDeliveryStats(ctx as never, '/worktree', 'main', 'head789')

  assert.deepEqual(stats, {
    commits: [
      { hash: 'abc123', subject: '补充测试' },
      { hash: 'def456', subject: '实现审计' },
    ],
    filesChanged: 3,
    insertions: 13,
    deletions: 2,
    diffstat: [
      { path: 'src/a.ts', insertions: 10, deletions: 2 },
      { path: 'assets/logo.png', insertions: null, deletions: null },
      { path: 'src/b.ts', insertions: 3, deletions: 0 },
    ],
  })
  assert.equal(commands.length, 3)
  assert.match(commands[1], /base123\.\.head789/)
  assert.match(commands[2], /base123\.\.head789/)
})

test('delivery stats fail soft when the fork point cannot be resolved', async () => {
  const ctx = {
    shell: {
      resolve(spec: { command: string }) {
        return spec
      },
      async run() {
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'missing ref' } }
      },
    },
  }
  assert.equal(await readDeliveryStats(ctx as never, '/worktree', 'main', 'head789'), undefined)
})
