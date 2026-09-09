/** Read-only Git scene included in an offline migration's exact authorization. */
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ClickVibeConfigV1 } from './contracts.ts'
import { verifyProjectBindingRepository } from './repository-identity.ts'
import { digest } from './recovery-upgrade-files.ts'
const exec = promisify(execFile)
export interface RecoveryGitScene {
  repositoryId: string
  repoKey: string
  localPath: string
  commonDir: string
  remoteHash: string
  porcelain: string
  worktrees: Record<string, { present: boolean; dirty?: boolean; statusHash?: string }>
}
async function git(path: string, ...args: string[]): Promise<string> {
  try {
    return (
      await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout
  } catch {
    throw new Error('Git inventory unavailable; keep the host stopped and inspect the repository')
  }
}
export async function observeRecoveryGit(config: ClickVibeConfigV1): Promise<RecoveryGitScene[]> {
  const scenes: RecoveryGitScene[] = [],
    names = new Set<string>()
  for (const binding of config.projectBindings) {
    const repo = await verifyProjectBindingRepository(binding)
    const name = basename(repo.localPath)
    if (names.has(name)) throw new Error('worktree path collision: repositories share the same basename')
    names.add(name)
    const porcelain = await git(repo.localPath, 'worktree', 'list', '--porcelain', '-z')
    const worktrees: RecoveryGitScene['worktrees'] = Object.create(null)
    for (const field of porcelain.split('\0')) {
      if (!field.startsWith('worktree ')) continue
      const path = field.slice(9)
      try {
        await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        worktrees[path] = { present: false }
        continue
      }
      const common = await realpath(resolve(path, (await git(path, 'rev-parse', '--git-common-dir')).trim()))
      if (common !== repo.commonDir) throw new Error('worktree ownership changed during inventory')
      const status = await git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal')
      worktrees[path] = { present: true, dirty: status.length > 0, statusHash: digest(status) }
    }
    scenes.push({
      repositoryId: repo.repositoryId,
      repoKey: binding.container.id,
      localPath: repo.localPath,
      commonDir: repo.commonDir,
      remoteHash: digest(repo.primaryRemoteUrl),
      porcelain,
      worktrees,
    })
  }
  return scenes.sort((a, b) => a.repoKey.localeCompare(b.repoKey))
}
