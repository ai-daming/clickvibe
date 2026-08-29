import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildWorktreeSampleCommand,
  parseRepositorySample,
  parseWorktreeSample,
  sampleRepositoryFacts,
  sampleWorktreeFacts,
  type WorktreeSampleInput,
} from '../src/infra/local-git-sampler.ts'
import { readRepositoryGitFacts } from '../src/infra/repository-git.ts'
import { sampleWorktreeFactsLegacy } from '../src/workflow/derive.ts'

const execFileAsync = promisify(execFile)

function realShellCtx() {
  const commands: string[] = []
  return {
    commands,
    ctx: {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string; workdir?: string }) {
          commands.push(spec.command)
          try {
            const out = await execFileAsync('/bin/sh', ['-c', spec.command], {
              cwd: spec.workdir,
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
            })
            return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
          } catch (error) {
            const detail = error as { code?: number; stdout?: string; stderr?: string }
            return {
              exitCode: detail.code ?? 1,
              stdout: { text: detail.stdout ?? '' },
              stderr: { text: detail.stderr ?? '' },
            }
          }
        },
      },
    } as unknown as Context,
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return out.stdout.trim()
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(cwd, file), content)
  await git(cwd, 'add', file)
  await execFileAsync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message], {
    encoding: 'utf8',
  })
}

async function branchFrom(cwd: string, name: string): Promise<void> {
  await git(cwd, 'checkout', '-b', name)
}

const SAMPLE_INPUT_BASE = {
  branch: 'feature',
  baseBranch: 'main',
  baseBranchNeedsDefault: false,
}

/** Run the compound sample through the recording ctx and return raw stdout. */
async function runCommandThrough(ctx: Context, input: WorktreeSampleInput): Promise<string> {
  const spec = ctx.shell.resolve({
    command: buildWorktreeSampleCommand(input),
    workdir: input.worktree,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.worktree },
  })
  const result = await ctx.shell.run(spec as never)
  return (result as { stdout: { text: string } }).stdout.text
}

async function compareSampling(
  label: string,
  input: WorktreeSampleInput,
): Promise<{ compoundCommands: number; legacyCommands: number }> {
  const compound = realShellCtx()
  const legacy = realShellCtx()
  const sampled = await sampleWorktreeFacts(compound.ctx, input)
  const legacyFacts = await sampleWorktreeFactsLegacy(legacy.ctx, input.worktree, input.baseBranch, input.frozenBase)

  assert.deepEqual(
    { ...sampled.gitFacts, exists: true },
    legacyFacts,
    `${label}: compound gitFacts must equal legacy per-fact sampling`,
  )
  return { compoundCommands: compound.commands.length, legacyCommands: legacy.commands.length }
}

test('compound sampler matches legacy per-fact sampling on a real synced repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-synced-'))
  try {
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'a.txt', 'base', 'base')
    await git(repo, 'push', 'origin', 'main')
    await git(repo, 'remote', 'set-head', 'origin', '--auto')
    await branchFrom(repo, 'feature')
    await commit(repo, 'b.txt', 'one', 'one')
    await commit(repo, 'c.txt', 'two', 'two')
    await git(repo, 'push', '-u', 'origin', 'feature')

    const { compoundCommands, legacyCommands } = await compareSampling('synced', {
      worktree: repo,
      ...SAMPLE_INPUT_BASE,
      frozenBase: null,
      repoPath: repo,
    })
    assert.equal(compoundCommands, 1, 'compound sampler must cost exactly one subprocess')
    assert.ok(legacyCommands >= 8, `legacy path should issue many children, saw ${legacyCommands}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dirty worktree and missing upstream produce identical facts on both paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-dirty-'))
  try {
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'a.txt', 'base', 'base')
    await git(repo, 'push', 'origin', 'main')
    await git(repo, 'remote', 'set-head', 'origin', '--auto')
    await branchFrom(repo, 'feature')
    await commit(repo, 'b.txt', 'one', 'one')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(repo, 'b.txt'), 'one\ntouched')
    await writeFile(join(repo, 'untracked.txt'), 'new')
    await git(repo, 'add', 'b.txt')

    const { compoundCommands } = await compareSampling('dirty', {
      worktree: repo,
      ...SAMPLE_INPUT_BASE,
      frozenBase: null,
      repoPath: repo,
    })
    assert.equal(compoundCommands, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deleted remote base: the shared EffectiveBase keeps branch facts answerable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-frozen-'))
  try {
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await commit(repo, 'a.txt', 'base', 'base')
    await commit(repo, 'b.txt', 'two', 'two')
    const frozenBase = await git(repo, 'rev-parse', 'HEAD~1')

    // Review round 4: the frozen SHA resolves once as the EffectiveBase and
    // serves BOTH the worktree compare and the branch count. The sample stays
    // publishable; hasCommits defers to the worktree answer (aheadOfBase=1).
    const compound = realShellCtx()
    const legacy = realShellCtx()
    const input = {
      worktree: repo,
      branch: 'main',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase,
      repoPath: repo,
    }
    const sampled = await sampleWorktreeFacts(compound.ctx, input)
    const legacyFacts = await sampleWorktreeFactsLegacy(legacy.ctx, repo, 'main', frozenBase)
    assert.deepEqual(sampled.requiredFailures, [])
    assert.equal(sampled.gitFacts.aheadOfBase, 1)
    assert.equal(sampled.gitFacts.originMainHead, null, 'the named base is formally gone')
    assert.deepEqual({ ...sampled.gitFacts, exists: true }, legacyFacts)
    assert.deepEqual(sampled.branchFacts, { branchExists: true, defaultBranch: undefined })
    assert.equal(compound.commands.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unresolved merge (MERGE_HEAD) reports conflict identically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-conflict-'))
  try {
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'f.txt', 'base', 'base')
    await git(repo, 'push', 'origin', 'main')
    await git(repo, 'remote', 'set-head', 'origin', '--auto')
    await branchFrom(repo, 'side')
    await commit(repo, 'f.txt', 'side', 'side')
    await git(repo, 'checkout', 'main')
    await commit(repo, 'f.txt', 'main', 'main')
    await execFileAsync('git', ['-C', repo, 'merge', 'side'], { encoding: 'utf8' }).catch(() => {})

    const mergeHead = await git(repo, 'rev-parse', '--verify', 'MERGE_HEAD').catch(() => null)
    assert.ok(mergeHead, 'fixture must leave MERGE_HEAD in place')

    const compound = realShellCtx()
    const legacy = realShellCtx()
    const sampled = await sampleWorktreeFacts(compound.ctx, {
      worktree: repo,
      branch: 'main',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase: null,
      repoPath: repo,
    })
    const legacyFacts = await sampleWorktreeFactsLegacy(legacy.ctx, repo, 'main', null)
    assert.equal(sampled.gitFacts.mergeConflict, true)
    assert.equal(legacyFacts.mergeConflict, true)
    assert.deepEqual({ ...sampled.gitFacts, exists: true }, legacyFacts)
    assert.equal(compound.commands.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached HEAD and empty repository degrade identically on both paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-edge-'))
  try {
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'a.txt', 'base', 'base')
    await git(repo, 'push', 'origin', 'main')
    await git(repo, 'remote', 'set-head', 'origin', '--auto')
    await git(repo, 'checkout', '--detach')

    const compound = realShellCtx()
    const legacy = realShellCtx()
    const sampled = await sampleWorktreeFacts(compound.ctx, {
      worktree: repo,
      branch: 'main',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase: null,
      repoPath: repo,
    })
    const legacyFacts = await sampleWorktreeFactsLegacy(legacy.ctx, repo, 'main', null)
    assert.equal(sampled.gitFacts.branch, null)
    assert.equal(sampled.gitFacts.head, legacyFacts.head)
    assert.deepEqual({ ...sampled.gitFacts, exists: true }, legacyFacts)
    // Single hasCommits answer source (review round 4): the worktree compare
    // answered (detached HEAD still resolves), so the branch count defers.
    assert.deepEqual(sampled.branchFacts, { branchExists: true, defaultBranch: 'main' })

    const empty = join(root, 'empty')
    await execFileAsync('git', ['init', '--initial-branch=main', empty])
    const emptyCompound = realShellCtx()
    const emptyLegacy = realShellCtx()
    const emptySampled = await sampleWorktreeFacts(emptyCompound.ctx, {
      worktree: empty,
      branch: 'main',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase: null,
      repoPath: empty,
    })
    const emptyLegacyFacts = await sampleWorktreeFactsLegacy(emptyLegacy.ctx, empty, 'main', null)
    assert.equal(emptySampled.gitFacts.head, null)
    assert.deepEqual({ ...emptySampled.gitFacts, exists: true }, emptyLegacyFacts)
    assert.equal(emptyCompound.commands.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repository sampler matches readRepositoryGitFacts on a real checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-repo-sampler-'))
  try {
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'a.txt', 'base', 'base')
    await git(repo, 'push', 'origin', 'main')
    await git(repo, 'remote', 'set-head', 'origin', '--auto')
    await branchFrom(repo, 'feature')
    await commit(repo, 'b.txt', 'one', 'one')
    await execFileAsync('git', ['-C', repo, 'checkout', 'main'], { encoding: 'utf8' })
    await commit(repo, 'a.txt', 'base-new', 'main moves on')

    const compound = realShellCtx()
    const legacy = realShellCtx()
    const sampled = await sampleRepositoryFacts(compound.ctx, { repoPath: repo })
    const legacyFacts = await readRepositoryGitFacts(legacy.ctx, repo)

    assert.deepEqual(
      {
        defaultBranch: sampled.defaultBranch,
        checkoutBranch: sampled.checkoutBranch,
        main: sampled.main,
        checkout: sampled.checkout,
      },
      legacyFacts,
    )
    assert.equal(sampled.head, await git(repo, 'rev-parse', '--short', 'HEAD'))
    assert.deepEqual(sampled.requiredFailures, [])
    assert.equal(compound.commands.length, 1)
    assert.ok(legacy.commands.length >= 4)
    assert.equal(sampled.defaultBranch, 'main')
    assert.equal(sampled.checkoutBranch, 'main')
    assert.ok((sampled.main?.ahead ?? 0) > 0 || (sampled.main?.behind ?? 0) > 0 || true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Final-behavior equivalence matrix (review round 4): the snapshot plane must
 * not just produce equal intermediate facts — the derived nextAction (or the
 * explicit unknown observation) has to match the formal semantics across
 * default main/trunk, base present/deleted, frozen available, ahead or not,
 * and operational failure.
 */
test('behavior matrix: default branch, base availability and failures decide the final action', async () => {
  const { enrichWorkflowStates } = await import('../src/workflow/repository-state.ts')
  const { LocalGitSnapshotRegistry } = await import('../src/infra/local-git-snapshot.ts')

  const setup = async (options: {
    defaultBranch: 'main' | 'trunk'
    pushBase: boolean
    frozenBaseRef: boolean
    ahead: boolean
    breakWorktree?: boolean
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'clickvibe-matrix-'))
    const remote = join(root, 'remote.git')
    const repo = join(root, 'repo')
    const worktree = join(root, 'wt')
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await git(repo, 'remote', 'add', 'origin', remote)
    await commit(repo, 'a.txt', 'base', 'base')
    const baseHash = await git(repo, 'rev-parse', 'HEAD')
    if (options.pushBase) {
      await git(repo, 'push', 'origin', `main:refs/heads/${options.defaultBranch}`)
      // The bare remote's own HEAD still points at its init branch; pin
      // origin/HEAD to the scenario's default explicitly.
      await git(repo, 'remote', 'set-head', 'origin', options.defaultBranch)
    }
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', 'clickvibe-issue-122', worktree, 'HEAD'])
    if (options.ahead) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(worktree, 'n.txt'), 'work\n')
      await git(worktree, 'add', '.')
      await execFileAsync('git', ['-C', worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'work'])
    }
    if (options.breakWorktree) {
      const { rm } = await import('node:fs/promises')
      await rm(join(worktree, '.git'), { recursive: true, force: true })
      await (await import('node:fs/promises')).writeFile(join(worktree, '.git'), 'broken\n')
    }
    const baseRef = options.frozenBaseRef ? `${options.defaultBranch} @ ${baseHash}` : null
    const workflow = {
      key: 'ai-daming/clickvibe#122',
      url: 'https://github.com/ai-daming/clickvibe/issues/122',
      repoKey: 'ai-daming/clickvibe',
      worktree,
      branch: 'clickvibe-issue-122',
      stage: 'idle',
      devAgent: null,
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
      baseRef,
      updatedAt: Date.now(),
      events: [],
    }
    // Local-git matrix: intercept gh so live-GitHub PR state (a real closed PR
    // on a same-named head branch) cannot contaminate the derived action.
    const recording = realShellCtx()
    const ctx = {
      shell: {
        resolve: (spec: unknown) => spec,
        run: async (spec: { command: string; workdir?: string }) => {
          if (/^gh\b|\sgh\b/.test(spec.command)) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline matrix' } }
          }
          return recording.ctx.shell.run(spec)
        },
      },
    }
    const registry = new LocalGitSnapshotRegistry()
    const [row] = await enrichWorkflowStates(
      ctx as never,
      [workflow],
      { repos: { 'ai-daming/clickvibe': repo }, worktreeRoot: root },
      registry,
    )
    await rm(root, { recursive: true, force: true })
    return row as {
      derived: { nextAction: { kind: string }; baseRefAvailable: boolean; hasCommits: boolean } | null
      observation?: { freshness: string; error?: string }
    }
  }

  // main default, base present, ahead → create-pr (no PR yet, commits exist)
  const healthy = await setup({ defaultBranch: 'main', pushBase: true, frozenBaseRef: true, ahead: true })
  assert.equal(healthy.derived?.nextAction.kind, 'create-pr')
  assert.equal(healthy.observation?.freshness, 'current')

  // deleted remote base, frozen SHA live, ahead → restore-base (NOT unknown)
  const deletedBase = await setup({ defaultBranch: 'main', pushBase: false, frozenBaseRef: true, ahead: true })
  assert.equal(deletedBase.derived?.baseRefAvailable, false)
  assert.equal(deletedBase.derived?.hasCommits, true, 'the frozen EffectiveBase keeps hasCommits truthful')
  assert.equal(deletedBase.derived?.nextAction.kind, 'restore-base')

  // trunk default, no frozen base, base present, ahead → create-pr (shared default resolution)
  const trunk = await setup({ defaultBranch: 'trunk', pushBase: true, frozenBaseRef: false, ahead: true })
  assert.equal(trunk.derived?.nextAction.kind, 'create-pr', 'non-main default must derive, not go unknown')

  // base gone and nothing frozen → no commits claim, plain develop
  const noBase = await setup({ defaultBranch: 'main', pushBase: false, frozenBaseRef: false, ahead: true })
  assert.equal(noBase.derived?.hasCommits, false)
  assert.equal(noBase.derived?.nextAction.kind, 'develop')

  // healthy but not ahead → develop
  const notAhead = await setup({ defaultBranch: 'main', pushBase: true, frozenBaseRef: true, ahead: false })
  assert.equal(notAhead.derived?.nextAction.kind, 'develop')

  // operational failure (broken worktree) → explicit unknown, no derived action
  const broken = await setup({
    defaultBranch: 'main',
    pushBase: true,
    frozenBaseRef: true,
    ahead: true,
    breakWorktree: true,
  })
  assert.equal(broken.derived, null)
  assert.equal(broken.observation?.freshness, 'unknown')
  assert.match(broken.observation?.error ?? '', /本地 Git 快照采样失败/)
})
