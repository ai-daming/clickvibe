import assert from 'node:assert/strict'
import { exec, execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'
import { buildWorktreeAddCommand } from '../src/agent/develop.ts'
import { ensureWorktree } from '../src/agent/worktree.ts'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

function realShellCtx() {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8' })
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
  }
}

test('real git worktree creation uses origin/main instead of the source repository HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-worktree-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  try {
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git('fetch', 'origin', '--prune')
    await git('switch', '-c', 'accidental-side')
    await git('commit', '--allow-empty', '-m', 'side')
    const base = (await git('rev-parse', 'origin/main')).stdout.trim()
    const side = (await git('rev-parse', 'HEAD')).stdout.trim()

    const command = buildWorktreeAddCommand({
      path: worktree,
      branch: 'issue-1',
      branchExists: false,
      remoteBase: 'origin/main',
    })
    await execAsync(command, { cwd: repo })
    const issue = (await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    const branch = (await execFileAsync('git', ['-C', worktree, 'branch', '--show-current'])).stdout.trim()
    assert.equal(issue, base)
    assert.notEqual(issue, side)
    assert.equal(branch, 'issue-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('first development creates from a selected remote branch and freezes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-selected-base-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'main base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git('switch', '-c', 'release/2.0')
    await git('commit', '--allow-empty', '-m', 'release base')
    await git('push', '-u', 'origin', 'release/2.0')
    await git('switch', 'main')
    await activateV02Home(home, { 'o/r': repo }, { worktreeRoot: worktreeRoot })

    const created = await ensureWorktree(
      realShellCtx() as never,
      { owner: 'o', repo: 'r', number: '60' },
      'origin/release/2.0',
    )
    assert.equal(created.ok, true)
    if (!created.ok) return
    const expected = (await git('rev-parse', 'origin/release/2.0')).stdout.trim()
    const expectedShort = (await git('rev-parse', '--short', 'origin/release/2.0')).stdout.trim()
    const actual = (await execFileAsync('git', ['-C', created.worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    assert.equal(actual, expected)
    assert.equal(created.workflow.baseRef, `origin/release/2.0 @ ${expectedShort}`)

    const changed = await ensureWorktree(
      realShellCtx() as never,
      { owner: 'o', repo: 'r', number: '60' },
      'origin/main',
    )
    assert.equal(changed.ok, false)
    if (!changed.ok) assert.match(changed.error, /基线已定格/)

    const missing = await ensureWorktree(
      realShellCtx() as never,
      { owner: 'o', repo: 'r', number: '61' },
      'origin/not-found',
    )
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error, /不存在或未 fetch/)

    const local = await ensureWorktree(realShellCtx() as never, { owner: 'o', repo: 'r', number: '62' }, 'release/2.0')
    assert.equal(local.ok, false)
    if (!local.ok) assert.match(local.error, /origin\/\*/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('a baseline persistence failure rolls back a newly created worktree and branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-rollback-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const target = join(worktreeRoot, 'repo', 'repo-issue-63')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    await activateV02Home(home, { 'o/r': repo }, { worktreeRoot: worktreeRoot })
    await chmod(join(home, '.clickvibe', 'state'), 0o500)

    const result = await ensureWorktree(realShellCtx() as never, { owner: 'o', repo: 'r', number: '63' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /无法定格开发基线/)
    await assert.rejects(execFileAsync('git', ['-C', target, 'rev-parse', 'HEAD']))
    await assert.rejects(git('show-ref', '--verify', 'refs/heads/repo-issue-63'))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await chmod(join(home, '.clickvibe', 'state'), 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
