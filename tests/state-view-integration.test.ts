import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { deriveWorkflowState, enrichWorkflowStates, type IssueWorkflow } from '../src/index.ts'
import { LineLog } from '../src/infra/develop-core.ts'
import { LineBuffer } from '../src/infra/line-buffer.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import { issueBodyHash } from '../src/infra/state.ts'

const execFileAsync = promisify(execFile)

/** A minimal real-shell ctx: resolve passes the spec through, run executes it. */
function realShellCtx() {
  return {
    webServer: {
      register() {
        return () => {}
      },
    },
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], {
            cwd: spec.workdir,
            encoding: 'utf8',
          })
          return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
        } catch (error) {
          const e = error as { code?: number; stdout?: string; stderr?: string }
          return { exitCode: e.code ?? 1, stdout: { text: e.stdout ?? '' }, stderr: { text: e.stderr ?? '' } }
        }
      },
      start() {
        throw new Error('not used')
      },
    },
  }
}

const ctx = realShellCtx() as never

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-stateview-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await git('config', 'user.name', 'clickvibe-test')
  await git('config', 'user.email', 'clickvibe-test@example.invalid')
  await git('commit', '--allow-empty', '-m', 'base A')
  await git('branch', '-M', 'main')
  await git('push', '-u', 'origin', 'main')
  await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git('fetch', 'origin', '--prune')
  // issue worktree from origin/main (the base clickvibe guarantees)
  await git('worktree', 'add', '-b', 'clickvibe-issue-5', worktree, 'origin/main')
  const baseA = (await git('rev-parse', '--short', 'origin/main')).stdout.trim()
  return { root, repo, worktree, git, wt, baseA }
}

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
    baseRef: null,
    updatedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

test('state exposes only the current in-memory task start time', async () => {
  const wf = workflow({ stage: 'developing', devTaskId: 'dev-live' })
  liveTasks.set('dev-live', {
    taskId: 'dev-live',
    workflowKey: wf.key,
    workflow: wf,
    kind: 'dev',
    agent: 'codex',
    startedAt: 1_720_000_000_000,
    log: new LineLog(10),
    rawLog: new LineBuffer(),
    closed: false,
    status: 'running',
    exitCode: null,
    sessionId: null,
  })
  try {
    assert.equal((await deriveWorkflowState(ctx, wf)).runStartedAt, 1_720_000_000_000)
    liveTasks.get('dev-live')!.closed = true
    assert.equal((await deriveWorkflowState(ctx, wf)).runStartedAt, null)
  } finally {
    liveTasks.delete('dev-live')
  }
  assert.equal((await deriveWorkflowState(ctx, wf)).runStartedAt, null)
})

test('state view derives worktree/main/remote hashes, ahead-behind and sync need', async () => {
  const { root, worktree, git, wt, baseA } = await setupRepo()
  try {
    // 开发提交 C(worktree 领先 main 1)
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const headC = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
    assert.notEqual(headC, baseA)

    const derived = (await deriveWorkflowState(ctx, workflow({ worktree }))).derived
    assert.equal(derived.head, headC)
    assert.equal(derived.branch, 'clickvibe-issue-5')
    assert.equal(derived.mainHead, baseA) // 本地 main 未动
    assert.equal(derived.originMainHead, baseA)
    assert.equal(derived.behindBase, 0)
    assert.equal(derived.aheadOfBase, 1)
    assert.equal(derived.needsSync, false)
    assert.equal(derived.nextAction.kind, 'create-pr') // 有提交但无 PR → 先创建 PR

    // 并行开发:main 前进到 B,worktree 落后 → 需要同步
    await git('switch', 'main')
    await git('commit', '--allow-empty', '-m', 'parallel base B')
    const baseB = (await git('rev-parse', '--short', 'HEAD')).stdout.trim()
    await git('push', 'origin', 'main')
    await wt('fetch', 'origin', '--prune')

    const stale = (await deriveWorkflowState(ctx, workflow({ worktree }))).derived
    assert.equal(stale.originMainHead, baseB)
    assert.equal(stale.behindBase, 1)
    assert.equal(stale.aheadOfBase, 1)
    assert.equal(stale.needsSync, true)
    assert.equal(stale.nextAction.kind, 'sync') // 落后远端 → 唯一动作是同步

    // 同步后(模拟 /sync 的 merge):不再落后,唯一动作回到 review
    await wt('merge', '--no-edit', 'origin/main')
    const synced = (await deriveWorkflowState(ctx, workflow({ worktree }))).derived
    assert.equal(synced.behindBase, 0)
    assert.equal(synced.needsSync, false)
    assert.equal(synced.nextAction.kind, 'create-pr')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('review verdict binds to the reviewed HEAD and goes stale when the head moves', async () => {
  const { root, worktree, wt } = await setupRepo()
  try {
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const headC = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()

    // review 结论绑定 HEAD C(与事件时间线一致)
    const issueContract = { bodyHash: issueBodyHash('## 验收标准\n- A'), updatedAt: '2026-08-22T00:00:00Z' }
    const wf = workflow({
      worktree,
      prNumber: '9',
      reviewResult: { passed: true, issues: [] },
      events: [
        {
          kind: 'review',
          at: new Date().toISOString(),
          hash: headC,
          verdict: { passed: true, issues: [] },
          issueContract,
        },
      ],
      stage: 'review-ready',
    })
    const current = (await deriveWorkflowState(ctx, wf, { issueContract })).derived
    assert.equal(current.reviewedHash, headC)
    assert.equal(current.verdictCurrent, true)
    assert.equal(current.nextAction.kind, 'merge')

    // HEAD 前进(如合并远端基线)后,旧结论不再冒充当前状态
    await wt('commit', '--allow-empty', '-m', 'post-review commit')
    const stale = (await deriveWorkflowState(ctx, wf, { issueContract })).derived
    assert.equal(stale.head === headC, false)
    assert.equal(stale.verdictCurrent, false)
    assert.equal(stale.nextAction.kind, 'review')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('review verdict goes stale when the issue acceptance contract changes', async () => {
  const { root, worktree, wt } = await setupRepo()
  try {
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const head = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
    const reviewedContract = { bodyHash: issueBodyHash('## 验收标准\n- A'), updatedAt: '2026-08-22T00:00:00Z' }
    const currentContract = { bodyHash: issueBodyHash('## 验收标准\n- A\n- B'), updatedAt: '2026-08-22T01:00:00Z' }
    const wf = workflow({
      worktree,
      prNumber: '9',
      reviewResult: { passed: true, issues: [] },
      events: [
        {
          kind: 'review',
          at: new Date().toISOString(),
          hash: head,
          verdict: { passed: true, issues: [] },
          issueContract: reviewedContract,
        },
      ],
      stage: 'passed',
    })

    const stale = (await deriveWorkflowState(ctx, wf, { issueContract: currentContract })).derived
    assert.equal(stale.reviewedHash, head)
    assert.equal(stale.issueContractStatus, 'changed')
    assert.equal(stale.issueContractCurrent, false)
    assert.equal(stale.verdictCurrent, false)
    assert.equal(stale.status, 'review-ready')
    assert.equal(stale.nextAction.kind, 'review')
    assert.match(stale.nextAction.hint, /验收已变更/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub-only approval is fail-closed with an explicit missing-snapshot reason', async () => {
  const { root, worktree, wt } = await setupRepo()
  try {
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const currentContract = { bodyHash: issueBodyHash('## 验收标准\n- A'), updatedAt: '2026-08-22T01:00:00Z' }
    const derived = (
      await deriveWorkflowState(ctx, workflow({ worktree, prNumber: '9' }), {
        pr: {
          number: '9',
          state: 'OPEN',
          mergedAt: null,
          headRefName: 'clickvibe-issue-5',
          url: 'https://github.com/o/r/pull/9',
          reviewDecision: 'APPROVED',
        },
        issueContract: currentContract,
      })
    ).derived
    assert.equal(derived.issueContractStatus, 'unknown')
    assert.equal(derived.issueContractUnknownReason, 'missing-review-snapshot')
    assert.equal(derived.verdictCurrent, false)
    assert.equal(derived.status, 'review-ready')
    assert.equal(derived.nextAction.kind, 'review')
    assert.match(derived.nextAction.hint, /缺少验收契约快照/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unavailable live issue contract blocks merge as unknown instead of changed', async () => {
  const { root, worktree, wt } = await setupRepo()
  try {
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const head = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
    const reviewedContract = { bodyHash: issueBodyHash('## 验收标准\n- A'), updatedAt: '2026-08-22T00:00:00Z' }
    const wf = workflow({
      worktree,
      prNumber: '9',
      stage: 'passed',
      reviewResult: { passed: true, issues: [] },
      events: [
        {
          kind: 'review',
          at: new Date().toISOString(),
          hash: head,
          verdict: { passed: true, issues: [] },
          issueContract: reviewedContract,
        },
      ],
    })
    const derived = (await deriveWorkflowState(ctx, wf, { issueContract: null })).derived
    assert.equal(derived.issueContractStatus, 'unknown')
    assert.equal(derived.issueContractUnknownReason, 'current-contract-unavailable')
    assert.equal(derived.verdictCurrent, false)
    assert.equal(derived.nextAction.kind, 'none')
    assert.equal(derived.nextAction.label, '刷新验收状态')
    assert.doesNotMatch(derived.nextAction.hint, /已变更/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('metadata-only updatedAt drift does not invalidate an unchanged issue body', async () => {
  const { root, worktree, wt } = await setupRepo()
  try {
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    const head = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
    const bodyHash = issueBodyHash('## 验收标准\n- A')
    const wf = workflow({
      worktree,
      prNumber: '9',
      reviewResult: { passed: true, issues: [] },
      events: [
        {
          kind: 'review',
          at: new Date().toISOString(),
          hash: head,
          verdict: { passed: true, issues: [] },
          issueContract: { bodyHash, updatedAt: '2026-08-22T00:00:00Z' },
        },
      ],
      stage: 'passed',
    })

    const current = (
      await deriveWorkflowState(ctx, wf, {
        issueContract: { bodyHash, updatedAt: '2026-08-22T01:00:00Z' },
      })
    ).derived
    assert.equal(current.issueContractCurrent, true)
    assert.equal(current.verdictCurrent, true)
    assert.equal(current.nextAction.kind, 'merge')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/state enrichment checks configured branches and runs GitHub lookups concurrently', async () => {
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
        if (spec.command.startsWith('git symbolic-ref'))
          return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
        if (spec.command.startsWith('git rev-list')) return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  try {
    const workflows = [
      workflow({
        worktree: join(root, 'missing-5'),
        branch: 'clickvibe-issue-5',
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
    assert.equal(maxGithub, 2)
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
