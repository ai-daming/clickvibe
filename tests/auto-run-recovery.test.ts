import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type IssueWorkflow, issueKey, loadWorkflow } from '../src/infra/state.ts'
import { requestAutoRunReconcile } from '../src/workflow/auto-run.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

test('a reconcile exception is preserved as controller-error, never session-interrupted', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-reconcile-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const key = issueKey('owner/repo', '111')
    const workflow: IssueWorkflow = {
      key,
      url: 'https://github.com/owner/repo/issues/111',
      repoKey: 'owner/repo',
      worktree: tempHome,
      branch: 'clickvibe-issue-111',
      stage: 'developing',
      devAgent: null,
      devTaskId: 'dev-task-111',
      devHostJobId: 'clickvibe-111',
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
      baseRef: 'origin/main @ 82e55b2',
      autoRun: {
        status: 'running',
        autoMerge: false,
        devAgent: 'codex',
        reviewAgent: 'codex',
        maxRounds: 20,
        budgetHours: 24,
        startedAt: '2026-08-24T00:00:00Z',
        deadline: '2026-08-25T00:00:00Z',
        step: 1,
        rounds: 0,
        unresolved: [],
        lastObservedAt: null,
        pausedReason: null,
      },
      updatedAt: Date.now(),
      events: [],
    }
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const ctx = Object.defineProperty({}, 'jobs', {
      get() {
        throw new Error('forced reconcile failure')
      },
    })
    requestAutoRunReconcile(ctx as never, key)

    let observed: IssueWorkflow | null = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      observed = await loadWorkflow(key)
      if (observed?.autoRun?.status === 'paused') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(observed?.autoRun?.status, 'paused')
    assert.equal(observed?.autoRun?.pausedReason, 'controller-error')
    assert.match(observed?.events.at(-1)?.note ?? '', /controller-error/)
    // 证据必须落盘:暂停原因之外,原始错误文本要写进本地事件(#90 事故:两次
    // controller-error 暂停均无法追溯,console 诊断几分钟内被滚动缓冲冲掉)。
    assert.match(observed?.events.at(-1)?.note ?? '', /forced reconcile failure/)
    const diagnosticPath = join(tempHome, '.clickvibe', 'state', 'owner', 'repo', 'issue-111', 'diagnostics.jsonl')
    let diagnostics = ''
    for (let attempt = 0; attempt < 50; attempt += 1) {
      diagnostics = await readFile(diagnosticPath, 'utf8').catch(() => '')
      if (diagnostics.includes('auto-run-reconcile-error')) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.notEqual(diagnostics, '')
    const reconcileError = diagnostics
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.event === 'auto-run-reconcile-error')
    assert.equal(reconcileError.errorName, 'Error')
    assert.equal(reconcileError.errorMessage, 'forced reconcile failure')
    assert.match(reconcileError.errorStack, /forced reconcile failure/)
    assert.equal(reconcileError.workflowKey, key)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

// ---- #120 切片②:限流按 reset 自动重试,不再暂停(GitHub 二级限流 +10min 签名) ----

test('a rate-limit reconcile failure defers to the reset time instead of pausing', async () => {
  const { GithubRateLimitError } = await import('../src/github/rest.ts')
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-ratelimit-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  let failure: Error = new GithubRateLimitError(Date.now() + 300)
  try {
    const key = issueKey('owner/repo', '120')
    const workflow: IssueWorkflow = {
      key,
      url: 'https://github.com/owner/repo/issues/120',
      repoKey: 'owner/repo',
      worktree: tempHome,
      branch: 'clickvibe-issue-120',
      stage: 'developing',
      devAgent: null,
      devTaskId: 'dev-task-120',
      devHostJobId: 'clickvibe-120',
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
      baseRef: 'origin/main @ 82e55b2',
      autoRun: {
        status: 'running',
        autoMerge: false,
        devAgent: 'codex',
        reviewAgent: 'codex',
        maxRounds: 20,
        budgetHours: 24,
        startedAt: '2026-08-25T00:00:00Z',
        deadline: '2026-08-26T00:00:00Z',
        step: 1,
        rounds: 0,
        unresolved: [],
        lastObservedAt: null,
        pausedReason: null,
      },
      updatedAt: Date.now(),
      events: [],
    }
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const ctx = Object.defineProperty({}, 'jobs', {
      get() {
        throw failure
      },
    })
    requestAutoRunReconcile(ctx as never, key)

    let observed: IssueWorkflow | null = null
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observed = await loadWorkflow(key)
      if (observed?.events.some((event) => (event.note ?? '').includes('限流'))) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // 限流不暂停:autoRun 保持 running,事件流写明等待与自动重试
    assert.equal(observed?.autoRun?.status, 'running', 'rate-limit must not pause the auto-run')
    assert.match(
      observed?.events.at(-1)?.note ?? '',
      /限流.*自动(等待|重试)/,
      'the durable event must explain the deferral',
    )

    // reset 过后的重试若遇到普通故障,仍按 controller-error 暂停(证据保留)
    failure = new Error('post-reset real failure')
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observed = await loadWorkflow(key)
      if (observed?.autoRun?.status === 'paused') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(observed?.autoRun?.pausedReason, 'controller-error')
    assert.match(observed?.events.at(-1)?.note ?? '', /post-reset real failure/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

// ---- defer 去抖(#122 现场:面板轮询使 open circuit 期间每 5s 产生一条限流事件+一次提交) ----

test('rapid rate-limit reconciles during one circuit window defer only once', async () => {
  const { GithubRateLimitError } = await import('../src/github/rest.ts')
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-defer-dedupe-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const key = issueKey('owner/repo', '122')
    const workflow: IssueWorkflow = {
      key,
      url: 'https://github.com/owner/repo/issues/122',
      repoKey: 'owner/repo',
      worktree: tempHome,
      branch: 'clickvibe-issue-122',
      stage: 'developing',
      devAgent: null,
      devTaskId: 'dev-task-122',
      devHostJobId: 'clickvibe-122',
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
      baseRef: 'origin/main @ 82e55b2',
      autoRun: {
        status: 'running',
        autoMerge: false,
        devAgent: 'codex',
        reviewAgent: 'codex',
        maxRounds: 20,
        budgetHours: 24,
        startedAt: '2026-08-25T00:00:00Z',
        deadline: '2026-08-26T00:00:00Z',
        step: 1,
        rounds: 0,
        unresolved: [],
        lastObservedAt: null,
        pausedReason: null,
      },
      updatedAt: Date.now(),
      events: [],
    }
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const resetAt = Date.now() + 120_000 // 远离触发,只验证去抖
    const ctx = Object.defineProperty({}, 'jobs', {
      get() {
        throw new GithubRateLimitError(resetAt)
      },
    })
    // 模拟面板轮询:熔断窗口内连续 3 次 reconcile
    requestAutoRunReconcile(ctx as never, key)
    await new Promise((resolve) => setTimeout(resolve, 50))
    requestAutoRunReconcile(ctx as never, key)
    await new Promise((resolve) => setTimeout(resolve, 50))
    requestAutoRunReconcile(ctx as never, key)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const observed = await loadWorkflow(key)
    const defers = (observed?.events ?? []).filter((event) => (event.note ?? '').includes('限流'))
    assert.equal(defers.length, 1, `同一熔断窗口只应记录一次等待,实际 ${defers.length} 次`)
    assert.equal(observed?.autoRun?.status, 'running')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
