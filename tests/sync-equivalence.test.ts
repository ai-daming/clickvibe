import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertReviewHeadMatchesPr, isSyncEquivalentMerge } from '../src/index.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { collectMergeGateFailures } from '../src/workflow/merge-gates.ts'

const execFileAsync = promisify(execFile)

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

/**
 * 基础仓库:main 上有 base.md;worktree 分支上完成被审提交 R(与 main 改动
 * 不冲突),随后 main 前进 —— 即 review 通过后需要同步的标准现场。
 */
async function setupSyncScene(options: { branchEditsConflictFile?: boolean; baseBranch?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-equiv-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const branch = 'clickvibe-issue-48'
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
  const baseBranch = options.baseBranch ?? 'main'
  if (baseBranch !== 'main') {
    await git('switch', '-c', baseBranch)
    await git('push', '-u', 'origin', baseBranch)
  }
  await git('fetch', 'origin', '--prune')
  const reviewedBase = (await git('rev-parse', `origin/${baseBranch}`)).stdout.trim()
  await git('worktree', 'add', '-b', branch, worktree, `origin/${baseBranch}`)
  // 被审提交 R:分支侧改动
  await writeFile(join(worktree, options.branchEditsConflictFile ? 'base.md' : 'feature.md'), 'dev work\n')
  await wt('add', '.')
  await wt('commit', '-m', 'dev work (reviewed R)')
  await wt('push', '-u', 'origin', branch)
  const reviewedShort = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
  const reviewedFull = (await wt('rev-parse', 'HEAD')).stdout.trim()
  // review 通过后所选基线前进
  await git('switch', baseBranch)
  await writeFile(join(repo, 'base.md'), `base B\n${options.branchEditsConflictFile ? 'main extra\n' : ''}`)
  await git('add', '.')
  await git('commit', '-m', 'base advances')
  await git('push', 'origin', baseBranch)
  const remoteBranchHead = async () => (await remoteGit('rev-parse', `refs/heads/${branch}`)).stdout.trim()
  return {
    root,
    remote,
    repo,
    worktree,
    branch,
    git,
    wt,
    remoteGit,
    reviewedBase,
    reviewedShort,
    reviewedFull,
    remoteBranchHead,
  }
}

test('pure sync merge of R with origin/main is sync-equivalent (issue #48)', async () => {
  const scene = await setupSyncScene()
  try {
    // 同步:worktree 合并最新 origin/main 并推送(PR HEAD H ≠ R)
    await scene.wt('merge', '--no-edit', 'origin/main')
    await scene.wt('push', 'origin', scene.branch)
    const head = await scene.remoteBranchHead()
    assert.notEqual(head, scene.reviewedFull)

    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head), true)
    // 全量哈希与短哈希均可判定
    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedFull, head), true)
    // 门禁:H 为纯同步合并时放行
    await assert.doesNotReject(assertReviewHeadMatchesPr(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head))
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('pure sync merge follows a custom frozen baseline', async () => {
  const scene = await setupSyncScene({ baseBranch: 'release/2.0' })
  try {
    await scene.wt('fetch', 'origin', '--prune')
    await scene.wt('merge', '--no-edit', 'origin/release/2.0')
    await scene.wt('push', 'origin', scene.branch)
    const head = await scene.remoteBranchHead()
    const parents = (await scene.wt('rev-list', '--parents', '-n', '1', head)).stdout.trim().split(/\s+/).slice(1)
    const reviewed = (await scene.wt('rev-parse', scene.reviewedShort)).stdout.trim()
    const releaseHead = (await scene.wt('rev-parse', 'origin/release/2.0')).stdout.trim()
    assert.equal(parents.includes(reviewed), true)
    assert.equal(parents.includes(releaseHead), true)
    assert.equal(
      await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head, 'release/2.0'),
      true,
    )
    await assert.doesNotReject(
      assertReviewHeadMatchesPr(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head, 'release/2.0'),
    )
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('pure sync merge accepts the exact advanced PR base without a review-base failure', async () => {
  const scene = await setupSyncScene({ baseBranch: 'release/2.0' })
  try {
    await scene.wt('fetch', 'origin', '--prune')
    await scene.wt('merge', '--no-edit', 'origin/release/2.0')
    const head = (await scene.wt('rev-parse', 'HEAD')).stdout.trim()
    const currentBase = (await scene.wt('rev-parse', 'origin/release/2.0')).stdout.trim()
    const workflow = {
      url: 'https://github.com/o/r/issues/60',
      worktree: scene.worktree,
      baseRef: `origin/release/2.0 @ ${scene.reviewedBase}`,
      reviewResult: { passed: true, issues: [] },
      events: [
        {
          kind: 'review',
          at: 'now',
          hash: scene.reviewedFull,
          verdict: { passed: true, issues: [] },
          reviewBase: { ref: 'release/2.0', sha: scene.reviewedBase },
        },
      ],
    } as unknown as IssueWorkflow
    const failures = await collectMergeGateFailures(ctx, workflow, head, {
      ref: 'release/2.0',
      sha: currentBase,
    })
    assert.equal(
      failures.some((failure) => failure.key === 'review-base'),
      false,
    )
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('identical hashes pass the gate without any git access (regression, issue #48)', async () => {
  // worktree 指向不存在的路径,证明哈希相等时完全短路、不触发 git
  await assert.doesNotReject(
    assertReviewHeadMatchesPr(ctx, 'owner/repo', '/nonexistent/worktree', 'abc1234', 'abc1234def5678'),
  )
})

test('manual conflict resolution in the sync merge breaks equivalence (issue #48)', async () => {
  const scene = await setupSyncScene({ branchEditsConflictFile: true })
  try {
    // 冲突同步:分支与 main 改同一文件,人工改写一行后完成 merge
    await assert.rejects(scene.wt('merge', '--no-edit', 'origin/main'))
    await writeFile(join(scene.worktree, 'base.md'), 'manually resolved, not a clean merge\n')
    await scene.wt('add', '.')
    await scene.wt('commit', '--no-edit')
    await scene.wt('push', 'origin', scene.branch)
    const head = await scene.remoteBranchHead()

    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head), false)
    await assert.rejects(
      assertReviewHeadMatchesPr(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head),
      /合并门禁拒绝/,
    )
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('branch-side commit after the sync merge is rejected (issue #48)', async () => {
  const scene = await setupSyncScene()
  try {
    await scene.wt('merge', '--no-edit', 'origin/main')
    // 同步之后又叠加分支侧新提交:即使树差异来自 R 之外也不放行
    await writeFile(join(scene.worktree, 'feature.md'), 'dev work\nextra branch commit\n')
    await scene.wt('add', '.')
    await scene.wt('commit', '-m', 'extra branch commit after sync')
    await scene.wt('push', 'origin', scene.branch)
    const head = await scene.remoteBranchHead()

    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head), false)
    await assert.rejects(
      assertReviewHeadMatchesPr(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head),
      /合并门禁拒绝/,
    )
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('PR head older than R (force-push fork) is rejected (issue #48)', async () => {
  const scene = await setupSyncScene()
  try {
    // 远端分支被拨回 R 的父提交:PR HEAD 比 R 旧
    const parent = (await scene.wt('rev-parse', `${scene.reviewedFull}^`)).stdout.trim()
    await scene.git('push', '-f', 'origin', `${parent}:refs/heads/${scene.branch}`)
    const head = await scene.remoteBranchHead()

    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head), false)
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('merging a non-main branch into R is not sync-equivalent (issue #48)', async () => {
  const scene = await setupSyncScene()
  try {
    // 另一条非 main 分支上的提交,合并进 R:即使树等价也拒绝
    await scene.git('switch', '-c', 'side-branch', 'origin/main~1')
    await writeFile(join(scene.repo, 'side.md'), 'side change\n')
    await scene.git('add', '.')
    await scene.git('commit', '-m', 'side change')
    await scene.git('push', '-u', 'origin', 'side-branch')
    await scene.wt('fetch', 'origin')
    await scene.wt('merge', '--no-edit', 'origin/side-branch')
    await scene.wt('push', 'origin', scene.branch)
    const head = await scene.remoteBranchHead()

    assert.equal(await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, scene.reviewedShort, head), false)
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})

test('missing reviewed commit locally fails closed (issue #48)', async () => {
  const scene = await setupSyncScene()
  try {
    // R 在本地不存在(如对象被回收):无法核实即不满足
    const head = await scene.remoteBranchHead()
    assert.equal(
      await isSyncEquivalentMerge(ctx, 'owner/repo', scene.worktree, '0123456789abcdef0123456789abcdef01234567', head),
      false,
    )
  } finally {
    await rm(scene.root, { recursive: true, force: true })
  }
})
