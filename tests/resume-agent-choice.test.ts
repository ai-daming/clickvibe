import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { waitForTaskPersistence } from '../src/agent/task-supervisor.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import { type IssueWorkflow, loadWorkflow } from '../src/infra/state.ts'
import { resumeDevelop } from '../src/workflow/resume.ts'
import { createFakeJobs } from './fake-jobs.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

function resumableWorkflow(home: string, issueNumber: number): IssueWorkflow {
  const url = `https://github.com/o/r/issues/${issueNumber}`
  return {
    key: `o-r-${issueNumber}`,
    url,
    repoKey: 'o/r',
    worktree: join(home, 'worktree'),
    branch: `r-issue-${issueNumber}`,
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'old-dev-task',
    devSessionId: 'old-codex-session',
    devSessionAgent: 'codex',
    devInterrupted: true,
    reviewAgent: 'claude',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: { passed: false, issues: ['keep existing artifact'] },
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc1234',
    issueSnapshot: {
      url,
      title: 'agent choice',
      body: '## 验收标准\n- switch only when fresh',
      state: 'OPEN',
      updatedAt: '2026-08-24T17:24:26Z',
      comments: [],
    },
    updatedAt: 1,
    events: Array.from({ length: 5 }, (_, index) => ({
      kind: 'review' as const,
      at: `2026-08-24T0${index}:00:00Z`,
      verdict: { passed: false, issues: [`round ${index + 1}`] },
    })),
  }
}

function fakeContext(starts: Array<{ command: string; prompt: string }>): Context {
  return {
    jobs: createFakeJobs(),
    shell: {
      resolve: (spec) => spec,
      run: async (spec) => {
        if (spec.command.startsWith('gh api ')) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      start: (spec) => {
        starts.push({ command: spec.command, prompt: spec.stdin ?? '' })
        const claude = spec.command.startsWith('claude ')
        let read = false
        return {
          status: 'running' as const,
          exitCode: 1,
          done: Promise.resolve(),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return {
              delta: claude
                ? '{"type":"system","session_id":"new-claude-session"}\n'
                : '{"type":"thread.started","thread_id":"new-codex-session"}\n',
              lossy: false,
            }
          },
          kill() {
            return true
          },
        }
      },
    },
  } as unknown as Context
}

async function waitForClosed(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (liveTasks.get(taskId)?.closed) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`task ${taskId} did not close`)
}

async function cleanupTask(taskId: string): Promise<void> {
  const task = liveTasks.get(taskId)
  if (!task) return
  if (task.cleanup) clearTimeout(task.cleanup)
  await waitForTaskPersistence(task)
  liveTasks.delete(taskId)
}

test('fresh resume adopts the requested agent, starts fresh and persists the actual agent', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-fresh-agent-'))
  process.env.HOME = tempHome
  let taskId = ''
  try {
    const workflow = resumableWorkflow(tempHome, 116)
    await mkdir(workflow.worktree, { recursive: true })
    await commitWorkflowFixture(workflow, null)
    const starts: Array<{ command: string; prompt: string }> = []

    const result = await resumeDevelop(fakeContext(starts), {
      url: workflow.url,
      agent: 'claude',
      context: 'fresh supplemental context',
      freshSession: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    taskId = result.taskId
    await waitForClosed(taskId)

    assert.equal(starts.length, 1)
    assert.equal(starts[0].command, 'claude -p --dangerously-skip-permissions --verbose --output-format stream-json')
    assert.match(starts[0].prompt, /全新会话;从当前快照与 worktree 重新建立上下文/)
    assert.match(starts[0].prompt, /fresh supplemental context/)
    const persisted = await loadWorkflow(workflow.key)
    assert.equal(persisted?.devAgent, 'claude')
    assert.equal(persisted?.devSessionId, 'new-claude-session')
    assert.equal(persisted?.devSessionAgent, 'claude')
  } finally {
    if (taskId) await cleanupTask(taskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('non-fresh resume ignores a different requested agent and continues the exact owned session', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-continued-agent-'))
  process.env.HOME = tempHome
  let taskId = ''
  try {
    const workflow = resumableWorkflow(tempHome, 117)
    await mkdir(workflow.worktree, { recursive: true })
    await commitWorkflowFixture(workflow, null)
    const starts: Array<{ command: string; prompt: string }> = []

    const result = await resumeDevelop(fakeContext(starts), {
      url: workflow.url,
      agent: 'claude',
      context: 'continued supplemental context',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    taskId = result.taskId
    await waitForClosed(taskId)

    assert.equal(starts.length, 1)
    assert.match(starts[0].command, /codex exec .* resume 'old-codex-session'/)
    assert.match(starts[0].prompt, /续接精确开发会话 old-codex-session/)
    assert.match(starts[0].prompt, /continued supplemental context/)
    const persisted = await loadWorkflow(workflow.key)
    assert.equal(persisted?.devAgent, 'codex')
    assert.equal(persisted?.devSessionId, 'new-codex-session')
    assert.equal(persisted?.devSessionAgent, 'codex')
  } finally {
    if (taskId) await cleanupTask(taskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
