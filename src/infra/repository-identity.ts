/** Durable clone identity stored in the real Git common directory. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectBinding } from './contracts.ts'
import { isRepositoryId, parseProjectBinding } from './project-binding.ts'

const execFileAsync = promisify(execFile)

export interface RepositoryIdentityLocation {
  localPath: string
  commonDir: string
  repositoryIdPath: string
}

export interface VerifiedProjectBindingRepository extends RepositoryIdentityLocation {
  repositoryId: string
  primaryRemoteUrl: string
}

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' })
    return result.stdout.trim()
  } catch (reason) {
    const detail = reason as { stderr?: string; message?: string }
    throw new Error(detail.stderr?.trim() || detail.message || String(reason))
  }
}

export async function inspectRepositoryIdentityLocation(repositoryPath: string): Promise<RepositoryIdentityLocation> {
  const requestedPath = resolve(repositoryPath)
  const bare = await git(requestedPath, 'rev-parse', '--is-bare-repository')
  if (bare === 'true') throw new Error(`repository identity does not support bare repository: ${requestedPath}`)
  const superproject = await git(requestedPath, 'rev-parse', '--show-superproject-working-tree')
  if (superproject !== '') throw new Error(`repository identity does not support submodule: ${requestedPath}`)
  const topLevel = await realpath(await git(requestedPath, 'rev-parse', '--show-toplevel'))
  const actualPath = await realpath(requestedPath)
  if (actualPath !== topLevel) {
    throw new Error(`repository identity requires the top-level checkout path: ${topLevel}`)
  }
  const commonDir = await realpath(await git(requestedPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  return {
    localPath: topLevel,
    commonDir,
    repositoryIdPath: join(commonDir, 'clickvibe', 'repository-id'),
  }
}

async function readRepositoryIdPath(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error(`repositoryId path is a symlink: ${path}`)
  if (!metadata.isFile()) throw new Error(`repositoryId path is not a regular file: ${path}`)
  const raw = await readFile(path, 'utf8')
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (!isRepositoryId(value) || (raw !== value && raw !== `${value}\n`)) {
    throw new Error(`invalid repositoryId file: ${path}`)
  }
  return value
}

async function existingRepositoryId(path: string): Promise<string | null> {
  try {
    return await readRepositoryIdPath(path)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw reason
  }
}

async function ensureIdentityDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
  }
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error(`repository identity directory is a symlink: ${path}`)
  if (!metadata.isDirectory()) throw new Error(`repository identity path is not a directory: ${path}`)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readRepositoryId(repositoryPath: string): Promise<string> {
  const location = await inspectRepositoryIdentityLocation(repositoryPath)
  const repositoryId = await existingRepositoryId(location.repositoryIdPath)
  if (repositoryId === null) throw new Error(`repositoryId is missing: ${location.repositoryIdPath}`)
  return repositoryId
}

export async function ensureRepositoryId(repositoryPath: string): Promise<string> {
  const location = await inspectRepositoryIdentityLocation(repositoryPath)
  const identityDirectory = dirname(location.repositoryIdPath)
  await ensureIdentityDirectory(identityDirectory)
  const existing = await existingRepositoryId(location.repositoryIdPath)
  if (existing !== null) return existing

  const repositoryId = `repo_${randomUUID()}`
  const temporary = join(identityDirectory, `.repository-id.tmp-${process.pid}-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${repositoryId}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  let published = false
  try {
    try {
      await link(temporary, location.repositoryIdPath)
      published = true
      await syncDirectory(identityDirectory)
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
    }
  } finally {
    await unlink(temporary).catch(() => {})
    if (published) await syncDirectory(identityDirectory)
  }
  return published ? repositoryId : readRepositoryIdPath(location.repositoryIdPath)
}

export async function verifyProjectBindingRepository(value: unknown): Promise<VerifiedProjectBindingRepository> {
  const binding = parseProjectBinding(value)
  const location = await inspectRepositoryIdentityLocation(binding.repository.localPath)
  const repositoryId = await readRepositoryIdPath(location.repositoryIdPath)
  if (repositoryId !== binding.repository.repositoryId) {
    throw new Error(
      `repositoryId mismatch: config pins ${binding.repository.repositoryId}, clone contains ${repositoryId}`,
    )
  }
  let primaryRemoteUrl: string
  try {
    primaryRemoteUrl = await git(location.localPath, 'remote', 'get-url', binding.repository.primaryRemote)
  } catch (reason) {
    throw new Error(
      `ProjectBinding primaryRemote ${binding.repository.primaryRemote} does not exist: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  }
  return { ...location, repositoryId, primaryRemoteUrl }
}
