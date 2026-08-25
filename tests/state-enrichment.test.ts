import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { enrichWorkflowStates, type IssueWorkflow } from '../src/index.ts'
import { issueBodyHash } from '../src/infra/state.ts'

function workflow(overrides: Partial<IssueWorkflow> = {}): IssueWorkflow {
  return {
    key: 'repo-5',
    url: 'https://github.com/o/r/issues/5',
    repoKey: 'o/r',
    worktree: '',
    branch: 'clickvibe-issue-5',
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
    baseRef: 'origin/main @ abc123',
    updatedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

test('/state enrichment checks configured branches while the host serializes GitHub request bursts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-state-enrich-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  let activeGithub = 0
  let maxGithub = 0
  const githubTimeouts: number[] = []
  const fakeCtx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; timeoutMs?: number }) {
        if (spec.command.startsWith('gh api ') && spec.command.includes('/pulls?state=all')) {
          githubTimeouts.push(spec.timeoutMs ?? 0)
          activeGithub += 1
          maxGithub = Math.max(maxGithub, activeGithub)
          await new Promise((resolve) => setTimeout(resolve, 40))
          activeGithub -= 1
          return { exitCode: 0, stdout: { text: 'HTTP/2.0 200 OK\n\n[]' }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('if git show-ref')) {
          const branch = spec.command.includes('issue-6') ? 'clickvibe-issue-6' : 'clickvibe-issue-5'
          return { exitCode: 0, stdout: { text: branch }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('git symbolic-ref')) {
          return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('git rev-list')) {
          return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  try {
    const workflows = [
      workflow({
        worktree: join(root, 'missing-5'),
        stage: 'passed',
        reviewResult: { passed: true, issues: [] },
        events: [
          {
            kind: 'review',
            at: new Date().toISOString(),
            hash: 'abc123',
            verdict: { passed: true, issues: [] },
            issueContract: { bodyHash: issueBodyHash('## 验收标准\n- A'), updatedAt: '2026-08-22T00:00:00Z' },
          },
        ],
      }),
      workflow({
        key: 'repo-6',
        url: 'https://github.com/o/r/issues/6',
        worktree: join(root, 'missing-6'),
        branch: 'clickvibe-issue-6',
      }),
    ]
    const enriched = await enrichWorkflowStates(fakeCtx as never, workflows, {
      repos: { 'o/r': repo },
      worktreeRoot: root,
    })
    assert.equal(maxGithub, 1)
    assert.deepEqual(githubTimeouts, [5000, 5000])
    assert.deepEqual(
      enriched.map((item) => item.derived.nextAction.label),
      ['恢复 worktree 继续开发', '恢复 worktree 继续开发'],
    )
    assert.equal(enriched[0].derived.issueContractStatus, 'unknown')
    assert.equal(enriched[0].derived.issueContractUnknownReason, 'current-contract-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
