import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyCommand,
  isExpectedProbeMiss,
  nearestRank,
  summarizeCommands,
} from '../scripts/measure-access-baseline.mjs'

test('access baseline uses nearest-rank percentiles without inventing missing samples', () => {
  assert.equal(nearestRank([30, 10, 20, 40], 0.5), 20)
  assert.equal(nearestRank([30, 10, 20, 40], 0.95), 40)
  assert.equal(nearestRank([], 0.95), null)
})

test('access baseline keeps local, remote, GitHub and agent process costs separate', () => {
  assert.equal(classifyCommand('git status --porcelain'), 'localGit')
  assert.equal(classifyCommand('git fetch origin --prune'), 'remoteGit')
  assert.equal(classifyCommand('gh api --include repos/o/r/issues/1'), 'githubRest')
  assert.equal(classifyCommand('codex exec --json'), 'agentProcess')
  assert.equal(classifyCommand('printf done'), 'other')

  assert.deepEqual(
    summarizeCommands([
      { command: 'git status --porcelain', exitCode: 0 },
      { command: 'git fetch origin --prune', exitCode: 0 },
      { command: 'gh api --include repos/o/r/issues/1', exitCode: 1 },
      { command: 'git rev-parse MERGE_HEAD', exitCode: 128, expectedProbeMiss: true },
    ]),
    {
      physicalSubprocesses: 4,
      localGitSubprocesses: 2,
      remoteGitSubprocesses: 1,
      githubRestSubprocesses: 1,
      agentProcessSubprocesses: 0,
      failures: 1,
      expectedProbeMisses: 1,
    },
  )
})

test('access baseline separates absent-ref probes from operational failures', () => {
  assert.equal(
    isExpectedProbeMiss("if git show-ref --verify --quiet 'refs/heads/topic'; then printf yes; else exit 1; fi"),
    true,
  )
  assert.equal(isExpectedProbeMiss("git rev-parse --short 'origin/topic'"), true)
  assert.equal(isExpectedProbeMiss("git rev-parse --short 'MERGE_HEAD'"), true)
  assert.equal(isExpectedProbeMiss('git status --porcelain'), false)
})
