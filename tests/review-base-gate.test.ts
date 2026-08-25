import assert from 'node:assert/strict'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { collectMergeGateFailures } from '../src/workflow/merge-gates.ts'

test('retargeting a PR invalidates a passing review even when the head is unchanged', async () => {
  const contract = { bodyHash: 'same-body', updatedAt: 'now' }
  const workflow = {
    url: 'https://github.com/o/r/issues/60',
    worktree: '/tmp/worktree',
    baseRef: 'origin/release/2.0 @ abc1234',
    reviewResult: { passed: true, issues: [] },
    events: [
      {
        kind: 'review',
        at: 'now',
        hash: 'def9999',
        verdict: { passed: true, issues: [] },
        issueContract: contract,
        reviewBase: { ref: 'release/2.0', sha: 'abc1234' },
      },
    ],
  } as unknown as IssueWorkflow
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run() {
        return {
          exitCode: 0,
          stdout: {
            text: [
              'HTTP/2.0 200 OK',
              '',
              JSON.stringify({ body: '', state: 'open', title: '', updated_at: 'now' }),
            ].join('\n'),
          },
          stderr: { text: '' },
        }
      },
    },
  }
  const failures = await collectMergeGateFailures(ctx as never, workflow, 'def9999', {
    ref: 'integration',
    sha: 'fed8888',
  } as never)
  assert.ok(failures.some((failure) => failure.key === 'review-base'))
})
