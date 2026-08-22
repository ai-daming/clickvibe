import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildMergePreface, deriveWorkflowState, syncWorktree, type IssueWorkflow } from '../src/index.ts'
import { applyDevRunOutcome, loadWorkflow, saveWorkflow } from '../src/state.ts'

const execFileAsync = promisify(execFile)

/** A minimal real-shell ctx: resolve passes the spec through, run executes it. */
function realShellCtx() {
  return {
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
    },
  }
}

const ctx = realShellCtx() as never

/** Set up a repo whose worktree branch conflicts with the advanced origin/main. */
async function setupConflictedRepo() {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-conflict-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await git('config', 'user.name', 'clickvibe-test')
  await git('config', 'user.email', 'clickvibe-test@example.invalid')
  await writeFile(join(repo, 'readme.md'), 'base\n')
  await git('add', '.')
  await git('commit', '-m', 'base A')
  await git('branch', '-M', 'main')
  await git('push', '-u', 'origin', 'main')
  await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git('fetch', 'origin', '--prune')
  await git('worktree', 'add', '-b', 'clickvibe-issue-26', worktree, 'origin/main')
  // worktree 侧改动与 main 侧改动命中同一文件 → 必然冲突
  await writeFile(join(worktree, 'readme.md'), 'worktree version\n')
  await wt('add', '.')
  await wt('commit', '-m', 'dev work')
  await git('switch', 'main')
  await writeFile(join(repo, 'readme.md'), 'main version\n')
  await git('add', '.')
  await git('commit', '-m', 'parallel base B')
  await git('push', 'origin', 'main')
  return { root, repo, worktree, git, wt }
}

function conflictedWorkflow(worktree: string): IssueWorkflow {
  return {
    key: 'o-r-26', url: 'https://github.com/o/r/issues/26', repoKey: 'o/r',
    worktree, branch: 'clickvibe-issue-26', stage: 'review-ready',
    devAgent: 'codex', devTaskId: null, devSessionId: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null,
    reviewResult: { passed: false, issues: ['README 内容冲突'] },
    prNumber: null, issueState: 'OPEN', baseRef: null, updatedAt: Date.now(), events: [],
  }
}

/** Point the plugin state dir (~/.clickvibe) at a temp HOME for this test. */
async function withTempHome<T>(root: string, run: () => Promise<T>): Promise<T> {
  const home = join(root, 'home')
  await mkdir(join(home, '.clickvibe'), { recursive: true })
  const original = process.env.HOME
  // os.homedir() 在 POSIX 上每次读取 HOME 环境变量,不缓存
  process.env.HOME = home
  assert.equal(homedir(), home)
  try {
    return await run()
  } finally {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
  }
}

test('sync keeps the conflicted merge scene and rework stays reachable (issue #26)', async () => {
  const { root, worktree, git } = await setupConflictedRepo()
  try {
    await withTempHome(root, async () => {
      await saveWorkflow(conflictedWorkflow(worktree))

      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal(result.ok, false)
      assert.equal((result as { conflict?: boolean }).conflict, true)
      assert.match(result.error, /冲突/)

      // 现场保留:合并仍在进行(MERGE_HEAD 存在)、文件带冲突标记,没有被 abort
      const mergeHead = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--verify', 'MERGE_HEAD'])
      assert.match(mergeHead.stdout, /^[0-9a-f]+/)
      const content = await readFile(join(worktree, 'readme.md'), 'utf8')
      assert.match(content, /<<<<<<< HEAD/)

      // 冲突已记录到权威时间线
      const reloaded = await loadWorkflow('o-r-26')
      assert.ok(reloaded)
      const lastEvent = reloaded.events.at(-1)
      assert.equal(lastEvent?.kind, 'note')
      assert.match(lastEvent?.note ?? '', /冲突/)

      // 门禁降级:即使 worktree 仍落后(needsSync),失败结论的下一步是返工而非同步
      const derived = (await deriveWorkflowState(ctx, reloaded)).derived
      assert.equal(derived.needsSync, true)
      assert.equal(derived.nextAction.kind, 'rework')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an interrupted rework on a conflicted worktree resumes instead of re-syncing (issue #26)', async () => {
  const { root, worktree } = await setupConflictedRepo()
  try {
    await withTempHome(root, async () => {
      await saveWorkflow(conflictedWorkflow(worktree))
      // 冲突:现场保留
      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal((result as { conflict?: boolean }).conflict, true)

      // 用户点「按意见返工」:resumeDevelop 把 stage 置为 developing;
      // 随后返工 agent 非零退出(被停止/超时/Host 重启同理),
      // applyDevRunOutcome 把 stage 留在 developing、旧 review 结论保留。
      const started = await loadWorkflow('o-r-26')
      assert.ok(started)
      started.stage = 'developing'
      applyDevRunOutcome(started, 'failed', 1, null, 'codex')
      assert.equal(started.stage, 'developing')
      assert.equal(started.devInterrupted, true)
      assert.deepEqual(started.reviewResult, { passed: false, issues: ['README 内容冲突'] })
      await saveWorkflow(started)

      // 门禁不得退回 sync(那只会再次冲突):唯一动作是恢复会话,
      // 恢复 prompt 会前置「先解决未完成的合并」指令。
      const derived = (await deriveWorkflowState(ctx, started)).derived
      assert.equal(derived.needsSync, true)
      assert.equal(derived.nextAction.kind, 'resume')
      const preface = await buildMergePreface(ctx, worktree, 'main')
      assert.match(preface, /未完成的合并/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merge preface guides the resume/rework agent through conflict then staleness', async () => {
  const { root, worktree, git, wt } = await setupConflictedRepo()
  try {
    // 冲突合并中:指令是先解决未完成的合并
    await wt('fetch', 'origin', '--prune')
    await wt('merge', '--no-edit', 'origin/main').catch(() => {}) // 预期冲突
    const conflicted = await buildMergePreface(ctx, worktree, 'main')
    assert.match(conflicted, /未完成的合并/)

    // 冲突解决、合并完成后:不再有前置指令
    await writeFile(join(worktree, 'readme.md'), 'resolved\n')
    await wt('add', '.')
    await wt('commit', '--no-edit', '-m', 'resolve conflict')
    assert.equal(await buildMergePreface(ctx, worktree, 'main'), '')

    // 基线再次前进:指令改为先合并 origin/main
    await git('switch', 'main')
    await git('commit', '--allow-empty', '-m', 'parallel base C')
    await git('push', 'origin', 'main')
    await wt('fetch', 'origin', '--prune')
    const stale = await buildMergePreface(ctx, worktree, 'main')
    assert.match(stale, /落后 origin\/main/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
