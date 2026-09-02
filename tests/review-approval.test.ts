/**
 * Typed review approval (issue #131 slice B): the approval is a write
 * confirmation transaction — the fake shell answers the REST POST and the
 * reviews readback, and the outcomes assert the confirmed/failed best-effort
 * semantics that the review verdict never depends on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { approvePassedReview } from '../src/github/review-approval.ts'

interface CannedStep {
  command: string
  stdin?: string
}

function approvalCtx(handle: (step: CannedStep) => Promise<{ exitCode: number; text: string }>): {
  ctx: Context
  calls: CannedStep[]
} {
  const calls: CannedStep[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string; stdin?: string }) => {
        calls.push({ command: spec.command, stdin: spec.stdin })
        const result = await handle(spec)
        return { exitCode: result.exitCode, stdout: { text: result.text }, stderr: { text: '' } }
      },
    },
  } as unknown as Context
  return { ctx, calls }
}

const ok = (body: unknown, status = 200) => `HTTP/1.1 ${status}\n\n${JSON.stringify(body)}`
const APPROVAL_BODY = '**身份：Review Agent**\n\nLGTM'
const REVIEWED_HEAD = 'abc1234'
const OUR_APPROVAL = {
  state: 'APPROVED',
  body: APPROVAL_BODY,
  commit_id: `${REVIEWED_HEAD}9776f00d29c0`,
  user: { login: 'me' },
}

test('passed review with a PR submits a native GitHub approval', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx, calls } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 1 }, 201) }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return { exitCode: 0, text: ok([OUR_APPROVAL]) }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'approved')
  const post = calls.find((step) => step.command.includes('--method POST'))
  assert.ok(post, 'exactly the approval dispatch goes through POST')
  assert.match(post.command, /repos\/o\/r\/pulls\/29\/reviews/)
  assert.deepEqual(JSON.parse(post.stdin ?? '{}'), { event: 'APPROVE', body: APPROVAL_BODY })
  const readbacks = calls.filter((step) => !step.command.includes('--method POST'))
  assert.ok(readbacks.length >= 2, 'the confirmation readback runs after the dispatch')
  assert.match(
    readbacks.find((step) => step.command.includes('/reviews'))?.command ?? '',
    /repos\/o\/r\/pulls\/29\/reviews/,
  )
  assert.match(
    readbacks.find((step) => step.command.includes("'user'"))?.command ?? '',
    /'user'/,
    'the viewer identity pins the authenticated actor',
  )
  resetGithubGatewayOwnerForTests()
})

test('failed review stays neutral and does not submit an approval', async () => {
  const { ctx, calls } = approvalCtx(async () => ({ exitCode: 0, text: ok([]) }))
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: false, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'skipped')
  assert.equal(calls.length, 0)
})

test('a provable rejection is failed and best-effort — nothing escapes', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST'))
      return {
        exitCode: 1,
        text: `HTTP/1.1 422\n\n${JSON.stringify({ message: 'Can not approve your own pull request' })}`,
      }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return { exitCode: 0, text: ok([]) }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'failed')
  resetGithubGatewayOwnerForTests()
})

test('an uncertain approval settles through readback', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: 'connection reset' }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return { exitCode: 0, text: ok([OUR_APPROVAL]) }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'approved', 'the readback proves GitHub executed despite the lost response')
  resetGithubGatewayOwnerForTests()
})

test('an approval the readback cannot prove stays unknown', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 1 }, 201) }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return { exitCode: 0, text: ok([{ state: 'COMMENTED', body: 'someone else' }]) }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'unknown', 'a readback without the APPROVED entry proves nothing')
  resetGithubGatewayOwnerForTests()
})

test('review CF2: an APPROVED entry on a different commit does not confirm our approval', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: 'connection reset' }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return {
      exitCode: 0,
      text: ok([{ state: 'APPROVED', body: APPROVAL_BODY, commit_id: 'cafebabecafebabe', user: { login: 'me' } }]),
    }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'unknown', 'someone approved a different head — that proves nothing about ours')
  resetGithubGatewayOwnerForTests()
})

test('review CF2: an APPROVED entry by a different actor does not confirm our approval', async () => {
  resetGithubGatewayOwnerForTests()
  const { ctx } = approvalCtx(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: 'connection reset' }
    if (step.command.includes("'user'")) return { exitCode: 0, text: ok({ login: 'me' }) }
    return {
      exitCode: 0,
      text: ok([
        {
          state: 'APPROVED',
          body: APPROVAL_BODY,
          commit_id: `${REVIEWED_HEAD}9776f00d29c0`,
          user: { login: 'someone-else' },
        },
      ]),
    }
  })
  const result = await approvePassedReview(
    ctx,
    { repoKey: 'o/r', prNumber: '29', passed: true, reviewedHead: REVIEWED_HEAD },
    async () => {},
  )
  assert.equal(result, 'unknown', 'a foreign actor with the same body is not our approval')
  resetGithubGatewayOwnerForTests()
})
