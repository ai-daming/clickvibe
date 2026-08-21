import assert from 'node:assert/strict'
import { exec, execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildWorktreeAddCommand } from '../src/develop.ts'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

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
      path: worktree, branch: 'issue-1', branchExists: false, remoteBase: 'origin/main',
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
