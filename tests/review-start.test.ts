import assert from 'node:assert/strict'
import { commitWorkflowFixture } from './workflow-fixture.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadWorkflow } from '../src/infra/state.ts'
import { resolveReviewStartWorkflow, reviewStartError } from '../src/workflow/review-start.ts'

function included(body: unknown): string {
  return ['HTTP/2.0 200 OK', '', JSON.stringify(body)].join('\n')
}

test('review refusal messages distinguish task, development, cache, and completion failures', () => {
  assert.match(reviewStartError({ allowed: false, reason: 'task-running' }), /有进行中任务/)
  assert.match(reviewStartError({ allowed: false, reason: 'development-in-progress' }), /开发仍在进行/)
  assert.match(reviewStartError({ allowed: false, reason: 'workflow-cache-missing' }), /缓存缺失/)
  assert.match(reviewStartError({ allowed: false, reason: 'no-completion-facts' }), /尚无完成事实/)
})

test('review start recovers a missing workflow from matching branch, commit, and open PR facts', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-start-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'r')
    const worktreeRoot = join(tempHome, 'worktrees')
    const worktree = join(worktreeRoot, 'r', 'r-issue-106')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${worktreeRoot}`, ''].join('\n'),
    )

    const head = 'abc1234567890abcdef'
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string; workdir?: string }) {
          if (spec.command.startsWith('gh api ')) {
            const pr = {
              number: 105,
              state: 'open',
              merged_at: null,
              html_url: 'https://github.com/o/r/pull/105',
              head: { ref: 'r-issue-106', sha: head },
              base: { ref: 'main' },
            }
            return {
              exitCode: 0,
              stdout: {
                text: included(spec.command.includes('/pulls/105') ? pr : [pr]),
              },
              stderr: { text: '' },
            }
          }
          if (spec.command.startsWith('if git show-ref --verify --quiet')) {
            return { exitCode: 0, stdout: { text: 'r-issue-106' }, stderr: { text: '' } }
          }
          if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
            return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
          }
          if (spec.command.startsWith('git rev-list --count')) {
            return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
          }
          if (spec.command.includes('CLICKVIBE_WORKFLOW_GIT_STATUS')) {
            return {
              exitCode: 0,
              stdout: {
                text: [
                  'CLICKVIBE_WORKFLOW_GIT_STATUS',
                  '# branch.oid abc1234567890abcdef',
                  '# branch.head r-issue-106',
                  'CLICKVIBE_WORKFLOW_GIT_HEAD',
                  'abc1234',
                  'CLICKVIBE_WORKFLOW_GIT_EXPECTED_BRANCH',
                  'r-issue-106',
                  'CLICKVIBE_WORKFLOW_GIT_REFS',
                  'refs/heads/main\tabc1234\t\t0 1\t0 1',
                  'refs/remotes/origin/main\tabc1234\t\t0 1\t0 1',
                  'refs/remotes/origin/HEAD\tabc1234\torigin/main\t0 1\t0 1',
                  'refs/heads/r-issue-106\tabc1234\t\t0 0\t1 0',
                  'CLICKVIBE_WORKFLOW_GIT_MERGE_HEAD',
                  'CLICKVIBE_WORKFLOW_GIT_END',
                ].join('\n'),
              },
              stderr: { text: '' },
            }
          }
          if (spec.command === 'git rev-parse --short HEAD') {
            return { exitCode: 0, stdout: { text: 'abc1234' }, stderr: { text: '' } }
          }
          if (spec.command === 'git branch --show-current') {
            return { exitCode: 0, stdout: { text: 'r-issue-106' }, stderr: { text: '' } }
          }
          if (spec.command === 'git status --porcelain') {
            return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
          }
          if (spec.command.includes("git rev-parse --short 'MERGE_HEAD'")) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          if (spec.command.startsWith('git rev-parse --short')) {
            return { exitCode: 0, stdout: { text: 'abc1234' }, stderr: { text: '' } }
          }
          if (spec.command.startsWith('git rev-list --left-right --count')) {
            return { exitCode: 0, stdout: { text: '0 0' }, stderr: { text: '' } }
          }
          throw new Error(`unexpected command: ${spec.command}`)
        },
      },
    }

    const resolved = await resolveReviewStartWorkflow(
      ctx as never,
      { kind: 'issue', owner: 'o', repo: 'r', number: '106' },
      null,
    )
    assert.equal(resolved.ok, true, resolved.ok ? undefined : resolved.error)
    if (!resolved.ok) return
    assert.equal(resolved.workflow.stage, 'review-ready')
    assert.equal(resolved.workflow.prNumber, '105')
    // Recovery persists only Git/GitHub metadata. The review claim is the
    // first command allowed to advance durable lifecycle state.
    assert.equal((await loadWorkflow('o-r-106'))?.stage, 'idle')

    resolved.workflow.stage = 'developing'
    resolved.workflow.devInterrupted = true
    resolved.workflow.reviewResult = { passed: false, issues: ['resume this rework'] }
    await commitWorkflowFixture(resolved.workflow, resolved.workflow.revision ?? null)
    const interrupted = await resolveReviewStartWorkflow(
      ctx as never,
      { kind: 'issue', owner: 'o', repo: 'r', number: '106' },
      resolved.workflow,
    )
    assert.equal(interrupted.ok, false)
    if (interrupted.ok) return
    assert.match(interrupted.error, /开发仍在进行/)
    const preserved = await loadWorkflow('o-r-106')
    assert.equal(preserved?.stage, 'developing')
    assert.equal(preserved?.devInterrupted, true)
    assert.deepEqual(preserved?.reviewResult, { passed: false, issues: ['resume this rework'] })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
