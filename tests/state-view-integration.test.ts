import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { deriveWorkflowState, type IssueWorkflow } from '../src/index.ts'

const execFileAsync = promisify(execFile)

/** A minimal real-shell ctx: resolve passes the spec through, run executes it. */
function realShellCtx() {
  return {
    webServer: { register() { return () => {} } },
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string; workdir?: string }) {
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], {
            cwd: spec.workdir, encoding: 'utf8',
          })
          return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
        } catch (error) {
          const e = error as { code?: number; stdout?: string; stderr?: string }
          return { exitCode: e.code ?? 1, stdout: { text: e.stdout ?? '' }, stderr: { text: e.stderr ?? '' } }
        }
      },
      start() { throw new Error('not used') },
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
    key: 'repo-5', url: 'https://github.com/o/r/issues/5', repoKey: 'o/r',
    worktree: '', branch: 'clickvibe-issue-5', stage: 'review-ready',
    devAgent: 'codex', devTaskId: null, devSessionId: null, devInterrupted: false,
    reviewAgent: null, reviewTaskId: null, reviewSessionId: null, reviewResult: null,
    prNumber: null, issueState: 'OPEN', baseRef: null, updatedAt: Date.now(), events: [],
    ...overrides,
  }
}

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
    assert.equal(derived.mainHead, baseA)      // 本地 main 未动
    assert.equal(derived.originMainHead, baseA)
    assert.equal(derived.behindBase, 0)
    assert.equal(derived.aheadOfBase, 1)
    assert.equal(derived.needsSync, false)
    assert.equal(derived.nextAction.kind, 'review') // review-ready 无结论 → review

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
    assert.equal(synced.nextAction.kind, 'review')
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
    const wf = workflow({
      worktree,
      prNumber: '9',
      reviewResult: { passed: true, issues: [] },
      events: [{ kind: 'review', at: new Date().toISOString(), hash: headC, verdict: { passed: true, issues: [] } }],
      stage: 'review-ready',
    })
    const current = (await deriveWorkflowState(ctx, wf)).derived
    assert.equal(current.reviewedHash, headC)
    assert.equal(current.verdictCurrent, true)
    assert.equal(current.nextAction.kind, 'merge')

    // HEAD 前进(如合并远端基线)后,旧结论不再冒充当前状态
    await wt('commit', '--allow-empty', '-m', 'post-review commit')
    const stale = (await deriveWorkflowState(ctx, wf)).derived
    assert.equal(stale.head === headC, false)
    assert.equal(stale.verdictCurrent, false)
    assert.equal(stale.nextAction.kind, 'review')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
