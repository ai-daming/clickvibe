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
