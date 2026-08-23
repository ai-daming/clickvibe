import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { recordDevDelivery } from '../src/workflow/review-flow.ts'

function workflow(number: string): IssueWorkflow {
  return {
    key: `o-r-${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    repoKey: 'o/r',
    worktree: `/tmp/worktree-${number}`,
    branch: `r-issue-${number}`,
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/release/2.0 @ aaa0000',
    updatedAt: 0,
    events: [],
  }
}

test('successful dev delivery advances the durable tip only to a remote base commit contained by HEAD', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-integrated-tip-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    for (const [number, integrated] of [
      ['70', true],
      ['71', false],
    ] as const) {
      const item = workflow(number)
      const commands: string[] = []
      const ctx = {
        shell: {
          resolve(spec: unknown) {
            return spec
          },
          async run(spec: { command: string }) {
            commands.push(spec.command)
            if (spec.command.includes('refs/remotes/origin/release/2.0^{commit}')) {
              return { exitCode: 0, stdout: { text: 'bbb1111' }, stderr: { text: '' } }
            }
            if (spec.command === "git merge-base --is-ancestor 'bbb1111' 'head2222'") {
              return { exitCode: integrated ? 0 : 1, stdout: { text: '' }, stderr: { text: '' } }
            }
            if (spec.command.startsWith('gh issue comment')) {
              return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
            }
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'not available' } }
          },
        },
      }

      await recordDevDelivery(ctx as never, item, 'codex', 'head2222', [], 'resume')
      assert.equal(item.baseRef, integrated ? 'origin/release/2.0 @ bbb1111' : 'origin/release/2.0 @ aaa0000')
      assert.ok(commands.some((command) => command.includes('refs/remotes/origin/release/2.0^{commit}')))
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
