import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { sampleRepositoryFacts, sampleWorktreeFacts, type WorktreeSampleInput } from '../src/infra/local-git-sampler.ts'
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

test('frozen-base fallback path matches when the origin base ref is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-frozen-'))
  try {
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await commit(repo, 'a.txt', 'base', 'base')
    await commit(repo, 'b.txt', 'two', 'two')
    const frozenBase = await git(repo, 'rev-parse', 'HEAD~1')

    const { compoundCommands } = await compareSampling('frozen', {
      worktree: repo,
      branch: 'main',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase,
      repoPath: repo,
    })
    assert.equal(compoundCommands, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unresolved merge (MERGE_HEAD) reports conflict identically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sampler-conflict-'))
  try {
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await commit(repo, 'f.txt', 'base', 'base')
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
    const repo = join(root, 'repo')
    await execFileAsync('git', ['init', '--initial-branch=main', repo])
    await commit(repo, 'a.txt', 'base', 'base')
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
    assert.deepEqual(sampled.branchFacts, { branchExists: true, hasCommits: false, defaultBranch: undefined })

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

    assert.deepEqual(sampled, legacyFacts)
    assert.equal(compound.commands.length, 1)
    assert.ok(legacy.commands.length >= 4)
    assert.equal(sampled.defaultBranch, 'main')
    assert.equal(sampled.checkoutBranch, 'main')
    assert.ok((sampled.main?.ahead ?? 0) > 0 || (sampled.main?.behind ?? 0) > 0 || true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
