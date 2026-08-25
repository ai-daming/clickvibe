import assert from 'node:assert/strict'
import { commitWorkflowFixture } from './workflow-fixture.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  buildMergePreface,
  deriveWorkflowState,
  resumeDevelop,
  syncWorktree,
  type IssueWorkflow,
} from '../src/index.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import { applyDevRunOutcome, loadWorkflow, readLogTail } from '../src/infra/state.ts'
import { createFakeJobs } from './fake-jobs.ts'

const execFileAsync = promisify(execFile)
const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

/** A minimal real-shell ctx: resolve passes the spec through, run executes it. */
function realShellCtx() {
  return {
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
    },
  }
}

const ctx = realShellCtx() as never

async function waitForTaskClosed(taskId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (liveTasks.get(taskId)?.closed) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`task ${taskId} did not close within ${timeoutMs}ms`)
}

/** Set up a repo whose worktree branch conflicts with the advanced origin/main. */
async function setupConflictedRepo() {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-conflict-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  const remoteGit = (...args: string[]) => execFileAsync('git', [`--git-dir=${remote}`, ...args])
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
  return { root, repo, worktree, git, wt, remoteGit }
}

/** Set up an existing remote PR branch that can merge the advanced main cleanly. */
async function setupSyncableRepo(baseBranch = 'main') {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-push-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const branch = 'clickvibe-issue-45'
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  const remoteGit = (...args: string[]) => execFileAsync('git', [`--git-dir=${remote}`, ...args])
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await git('config', 'user.name', 'clickvibe-test')
  await git('config', 'user.email', 'clickvibe-test@example.invalid')
  await writeFile(join(repo, 'base.md'), 'base A\n')
  await git('add', '.')
  await git('commit', '-m', 'base A')
  await git('branch', '-M', 'main')
  await git('push', '-u', 'origin', 'main')
  await remoteGit('symbolic-ref', 'HEAD', 'refs/heads/main')
  if (baseBranch !== 'main') {
    await git('switch', '-c', baseBranch)
    await git('push', '-u', 'origin', baseBranch)
  }
  await git('fetch', 'origin', '--prune')
  await git('worktree', 'add', '-b', branch, worktree, `origin/${baseBranch}`)
  await writeFile(join(worktree, 'feature.md'), 'development\n')
  await wt('add', '.')
  await wt('commit', '-m', 'dev work')
  await wt('push', '-u', 'origin', branch)
  const remoteHeadBeforeSync = (await remoteGit('rev-parse', `refs/heads/${branch}`)).stdout.trim()
  await git('switch', baseBranch)
  await writeFile(join(repo, 'base.md'), 'base B\n')
  await git('add', '.')
  await git('commit', '-m', 'parallel base B')
  await git('push', 'origin', baseBranch)
  return { root, remote, worktree, branch, wt, remoteGit, remoteHeadBeforeSync }
}

function conflictedWorkflow(worktree: string): IssueWorkflow {
  return {
    key: 'o-r-26',
    url: 'https://github.com/o/r/issues/26',
    repoKey: 'o/r',
    worktree,
    branch: 'clickvibe-issue-26',
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewResult: { passed: false, issues: ['README 内容冲突'] },
    prNumber: null,
    issueState: 'OPEN',
    baseRef: null,
    issueSnapshot: {
      url: 'https://github.com/o/r/issues/26',
      title: 'conflict issue',
      body: '## 验收标准\n- resolve conflicts',
      state: 'OPEN',
      updatedAt: '2026-08-21T00:00:00Z',
      comments: [],
    },
    updatedAt: Date.now(),
    events: [],
  }
}

function syncableWorkflow(worktree: string, branch: string): IssueWorkflow {
  return {
    ...conflictedWorkflow(worktree),
    key: 'o-r-45',
    url: 'https://github.com/o/r/issues/45',
    branch,
    reviewResult: { passed: true, issues: [] },
    prNumber: '24',
    issueSnapshot: {
      url: 'https://github.com/o/r/issues/45',
      title: 'sync then push',
      body: '## 验收标准\n- push synced branch',
      state: 'OPEN',
      updatedAt: '2026-08-22T00:00:00Z',
      comments: [],
    },
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

test('sync pushes the clean merge commit to the existing PR branch (issue #45)', async () => {
  const { root, worktree, branch, wt, remoteGit, remoteHeadBeforeSync } = await setupSyncableRepo()
  try {
    await withTempHome(root, async () => {
      const workflow = syncableWorkflow(worktree, branch)
      await commitWorkflowFixture(workflow, null)

      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/45' })
      assert.equal(result.ok, true)
      const localHead = (await wt('rev-parse', 'HEAD')).stdout.trim()
      const localShortHead = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
      const remoteHead = (await remoteGit('rev-parse', `refs/heads/${branch}`)).stdout.trim()
      assert.notEqual(localHead, remoteHeadBeforeSync)
      assert.equal(remoteHead, localHead)
      assert.equal(result.head, localShortHead)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync merges and records the frozen custom baseline', async () => {
  const { root, worktree, branch, wt } = await setupSyncableRepo('release/2.0')
  try {
    await withTempHome(root, async () => {
      const item = syncableWorkflow(worktree, branch)
      item.baseRef = 'origin/release/2.0 @ frozen'
      await saveWorkflow(item)

      const result = await syncWorktree(ctx, { url: item.url })
      assert.equal(result.ok, true)
      const parents = (await wt('show', '-s', '--format=%P', 'HEAD')).stdout.trim().split(/\s+/)
      const releaseHead = (await wt('rev-parse', 'origin/release/2.0')).stdout.trim()
      assert.equal(parents.includes(releaseHead), true)
      const saved = await loadWorkflow(item.key)
      assert.equal(saved?.baseRef, `origin/release/2.0 @ ${releaseHead}`)
      assert.match(saved?.events.at(-1)?.note ?? '', /origin\/release\/2\.0/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync does not merge or push when the worktree has unrelated local changes (issue #45)', async () => {
  const { root, worktree, branch, wt, remoteGit, remoteHeadBeforeSync } = await setupSyncableRepo()
  try {
    await withTempHome(root, async () => {
      const workflow = syncableWorkflow(worktree, branch)
      await commitWorkflowFixture(workflow, null)
      await writeFile(join(worktree, 'local-notes.md'), 'uncommitted local change\n')

      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/45' })
      assert.equal(result.ok, false)
      assert.equal((result as { conflict?: boolean }).conflict, undefined)
      assert.match(result.error, /未提交改动/)
      const remoteHead = (await remoteGit('rev-parse', `refs/heads/${branch}`)).stdout.trim()
      assert.equal(remoteHead, remoteHeadBeforeSync)
      assert.match((await wt('status', '--short')).stdout, /local-notes\.md/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync keeps the conflicted merge scene and rework stays reachable (issue #26)', async () => {
  const { root, worktree, git, remoteGit } = await setupConflictedRepo()
  try {
    await withTempHome(root, async () => {
      const workflow = conflictedWorkflow(worktree)
      await commitWorkflowFixture(workflow, null)

      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal(result.ok, false)
      assert.equal((result as { conflict?: boolean }).conflict, true)
      assert.match(result.error, /冲突/)
      // 冲突详情透传(issue #26):文件清单随错误返回、记入日志与时间线
      assert.deepEqual((result as { files?: string[] }).files, ['readme.md'])
      assert.match(result.error, /readme\.md/)
      assert.match(result.error, /Automatic merge failed|CONFLICT|冲突/)
      const logLines = (await readLogTail('o-r-26', 'dev', 10)).join('\n')
      assert.match(logLines, /冲突文件:readme\.md/)

      // 现场保留:合并仍在进行(MERGE_HEAD 存在)、文件带冲突标记,没有被 abort
      const mergeHead = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--verify', 'MERGE_HEAD'])
      assert.match(mergeHead.stdout, /^[0-9a-f]+/)
      const content = await readFile(join(worktree, 'readme.md'), 'utf8')
      assert.match(content, /<<<<<<< HEAD/)
      await assert.rejects(remoteGit('rev-parse', 'refs/heads/clickvibe-issue-26'))

      // 冲突已记录到权威时间线(含文件清单)
      const reloaded = await loadWorkflow('o-r-26')
      assert.ok(reloaded)
      const lastEvent = reloaded.events.at(-1)
      assert.equal(lastEvent?.kind, 'note')
      assert.match(lastEvent?.note ?? '', /冲突/)
      assert.match(lastEvent?.note ?? '', /readme\.md/)

      // 门禁降级覆盖复审阶段(PR #33 现场):rework 完成后待复审(reviewResult
      // 已清空),冲突现场下唯一动作必须是恢复(由 agent 先解决冲突),不能是
      // 只会再次失败的 sync。
      const awaitingReReview = structuredClone(reloaded)
      awaitingReReview.stage = 'review-ready'
      awaitingReReview.reviewResult = null
      const reReviewDerived = (await deriveWorkflowState(ctx, awaitingReReview)).derived
      assert.equal(reReviewDerived.mergeConflict, true)
      assert.equal(reReviewDerived.needsSync, true)
      assert.equal(reReviewDerived.nextAction.kind, 'resume')

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
      const workflow = conflictedWorkflow(worktree)
      await commitWorkflowFixture(workflow, null)
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
      await commitWorkflowFixture(started, started.revision ?? null)

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

/** Capture agent launches: start() records command+prompt and reports an
 *  immediate non-zero exit (the "session died at once" shape). */
function capturingShellCtx(launches: { command: string; prompt: string }[]) {
  return {
    jobs: createFakeJobs(),
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
      start(spec: { command: string; stdin?: string }) {
        launches.push({ command: spec.command, prompt: spec.stdin ?? '' })
        return {
          status: 'running',
          exitCode: 1,
          done: Promise.resolve(),
          readOutput() {
            return { delta: '', lossy: false }
          },
          kill() {
            return false
          },
        }
      },
    },
  }
}

test('review issues reach the agent across stale-session fallback on an interrupted rework (issue #26)', async () => {
  const { root, worktree } = await setupConflictedRepo()
  const launches: { command: string; prompt: string }[] = []
  const captureCtx = capturingShellCtx(launches) as never
  try {
    await withTempHome(root, async () => {
      const workflow = conflictedWorkflow(worktree)
      await commitWorkflowFixture(workflow, null)
      const result = await syncWorktree(ctx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal((result as { conflict?: boolean }).conflict, true)

      // 返工中断:stage=developing、旧 review 结论保留;客户端 resume 不带 context
      const interrupted = await loadWorkflow('o-r-26')
      assert.ok(interrupted)
      interrupted.stage = 'developing'
      applyDevRunOutcome(interrupted, 'failed', 1, null, 'codex')

      // 场景 A:精确会话可续但秒退(stale)→ 回退全新会话。
      // 两次 launch 的 prompt 都必须带冲突指引 + 具体 review 意见。
      interrupted.devTaskId = 'dev-old'
      interrupted.devSessionId = 'dev-session-1'
      interrupted.devSessionAgent = 'codex'
      await commitWorkflowFixture(interrupted, interrupted.revision ?? null)
      const exact = await resumeDevelop(captureCtx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal(exact.ok, true)
      await waitForTaskClosed(exact.taskId)
      assert.equal(launches.length, 2) // 精确会话秒退 → 回退全新会话
      for (const launch of launches) {
        assert.match(launch.prompt, /未完成的合并/)
        assert.match(launch.prompt, /README 内容冲突/)
      }

      // 场景 B:会话归属不匹配 → 直接全新会话,意见同样送达
      const mismatched = await loadWorkflow('o-r-26')
      assert.ok(mismatched)
      mismatched.devSessionId = 'dev-session-2'
      mismatched.devSessionAgent = 'claude'
      await commitWorkflowFixture(mismatched, mismatched.revision ?? null)
      launches.length = 0
      const fresh = await resumeDevelop(captureCtx, { url: 'https://github.com/o/r/issues/26' })
      assert.equal(fresh.ok, true)
      await waitForTaskClosed(fresh.taskId)
      assert.equal(launches.length, 1)
      assert.match(launches[0]!.prompt, /未完成的合并/)
      assert.match(launches[0]!.prompt, /README 内容冲突/)

      // 客户端 rework 已带同样意见时,服务端补全不得重复
      launches.length = 0
      const rework = await resumeDevelop(captureCtx, {
        url: 'https://github.com/o/r/issues/26',
        context: 'README 内容冲突',
      })
      assert.equal(rework.ok, true)
      await waitForTaskClosed(rework.taskId)
      const occurrences = launches[0]!.prompt.split('README 内容冲突').length - 1
      assert.equal(occurrences, 1)
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
    assert.match(conflicted, /readme\.md/)

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

// ---- #127 现场:merge/cleanup 持久化冲突的良性重放 ----

test('replayMergeMetadata keeps concurrent disk events and memory cleanup state', async () => {
  const { replayMergeMetadata } = await import('../src/workflow/merge.ts')
  const disk = {
    events: [{ kind: 'auto-run', note: '磁盘上的并发事件(defer)' }],
    delivery: { status: 'archived' },
    issueState: 'CLOSED',
  } as never
  const memory = {
    events: [{ kind: 'merge', note: '内存旧快照的事件' }],
    delivery: { status: 'cleanup-pending', cleanup: { worktree: true } },
    issueState: 'OPEN',
  } as never
  // 重放规则:清理进度三件套(delivery/issueState/autoRun)以内存为准;
  // events 以磁盘为准——整对象快照不得覆盖并发事件。
  replayMergeMetadata(disk, memory)
  const replayed = disk as { events: unknown[]; delivery: { status: string }; issueState: string }
  assert.equal(replayed.delivery.status, 'cleanup-pending')
  assert.equal(replayed.issueState, 'OPEN')
  assert.equal(replayed.events.length, 1)
  assert.match(JSON.stringify(replayed.events[0]), /defer/)
})
