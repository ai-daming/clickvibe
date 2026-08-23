import assert from 'node:assert/strict'
import test from 'node:test'
import { approvePassedReview } from '../src/github/review-approval.ts'

test('passed review with a PR submits a native GitHub approval', async () => {
  const commands: string[] = []
  const result = await approvePassedReview(
    {
      repoKey: 'o/r',
      prNumber: '29',
      passed: true,
    },
    async (command) => {
      commands.push(command)
    },
  )

  assert.equal(result, 'approved')
  assert.deepEqual(commands, ["gh pr review 'https://github.com/o/r/pull/29' --approve --body 'LGTM'"])
})

test('failed review stays neutral and does not submit an approval', async () => {
  const commands: string[] = []
  const result = await approvePassedReview(
    {
      repoKey: 'o/r',
      prNumber: '29',
      passed: false,
    },
    async (command) => {
      commands.push(command)
    },
  )

  assert.equal(result, 'skipped')
  assert.deepEqual(commands, [])
})

test('native approval failure is best-effort and does not escape', async () => {
  const result = await approvePassedReview(
    {
      repoKey: 'o/r',
      prNumber: '29',
      passed: true,
    },
    async () => {
      throw new Error('Review Can not approve your own pull request')
    },
  )

  assert.equal(result, 'failed')
})
