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

export interface RepositoryIdentityWriteHandle {
  writeFile(value: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface RepositoryIdentityDirectoryHandle {
  sync(): Promise<void>
  close(): Promise<void>
}

/** Narrow file-operation boundary for deterministic durability failure testing. */
export interface RepositoryIdentityPublicationOperations {
  openTemporary(path: string): Promise<RepositoryIdentityWriteHandle>
  publish(temporary: string, destination: string): Promise<void>
  openDirectory(path: string): Promise<RepositoryIdentityDirectoryHandle>
  remove(path: string): Promise<void>
}

const nodePublicationOperations: RepositoryIdentityPublicationOperations = {
  async openTemporary(path) {
    const handle = await open(path, 'wx', 0o600)
    return {
      writeFile: (value) => handle.writeFile(value, 'utf8'),
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  publish: link,
  async openDirectory(path) {
    const handle = await open(path, 'r')
    return {
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  remove: unlink,
}

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' })
    return result.stdout.trim()
  } catch (reason) {
    const detail = reason as { stderr?: string; message?: string }
    const command = ['git', '-C', repositoryPath, ...args].join(' ')
    throw new Error(`${command} failed: ${detail.stderr?.trim() || detail.message || String(reason)}`)
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
  const dotGitPath = join(topLevel, '.git')
  const dotGit = await lstat(dotGitPath)
  if (dotGit.isSymbolicLink()) throw new Error(`untrusted gitdir symlink: ${dotGitPath}`)
  if (dotGit.isDirectory()) {
    if ((await realpath(dotGitPath)) !== commonDir) {
      throw new Error(`untrusted gitdir outside checkout: ${dotGitPath}`)
    }
  } else if (dotGit.isFile()) {
    const gitDir = await realpath(await git(requestedPath, 'rev-parse', '--path-format=absolute', '--git-dir'))
    if (dirname(gitDir) !== join(commonDir, 'worktrees')) {
      throw new Error(`untrusted gitdir outside registered worktrees: ${gitDir}`)
    }
  } else {
    throw new Error(`untrusted gitdir type: ${dotGitPath}`)
  }
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function captureFailure(failures: unknown[], operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (reason) {
    failures.push(reason)
  }
}

function throwFailures(failures: unknown[], action: string): void {
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, `${action}: ${failures.map(errorMessage).join('; ')}`)
}

async function syncDirectory(path: string, operations: RepositoryIdentityPublicationOperations): Promise<void> {
  const handle = await operations.openDirectory(path)
  const failures: unknown[] = []
  await captureFailure(failures, () => handle.sync())
  await captureFailure(failures, () => handle.close())
  throwFailures(failures, `directory sync failed for ${path}`)
}

export async function readRepositoryId(repositoryPath: string): Promise<string> {
  const location = await inspectRepositoryIdentityLocation(repositoryPath)
  const repositoryId = await existingRepositoryId(location.repositoryIdPath)
  if (repositoryId === null) throw new Error(`repositoryId is missing: ${location.repositoryIdPath}`)
  return repositoryId
}

export async function ensureRepositoryId(
  repositoryPath: string,
  operations: RepositoryIdentityPublicationOperations = nodePublicationOperations,
): Promise<string> {
  const location = await inspectRepositoryIdentityLocation(repositoryPath)
  const identityDirectory = dirname(location.repositoryIdPath)
  await ensureIdentityDirectory(identityDirectory)
  const existing = await existingRepositoryId(location.repositoryIdPath)
  if (existing !== null) return existing

  const repositoryId = `repo_${randomUUID()}`
  const temporary = join(identityDirectory, `.repository-id.tmp-${process.pid}-${randomUUID()}`)
  const handle = await operations.openTemporary(temporary)
  const preparationFailures: unknown[] = []
  await captureFailure(preparationFailures, () => handle.writeFile(`${repositoryId}\n`))
  if (preparationFailures.length === 0) await captureFailure(preparationFailures, () => handle.sync())
  await captureFailure(preparationFailures, () => handle.close())
  if (preparationFailures.length > 0) {
    await captureFailure(preparationFailures, () => operations.remove(temporary))
    throwFailures(preparationFailures, `repositoryId temporary preparation failed for ${temporary}`)
  }

  let published = false
  let contended = false
  const publicationFailures: unknown[] = []
  try {
    await operations.publish(temporary, location.repositoryIdPath)
    published = true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'EEXIST') contended = true
    else publicationFailures.push(reason)
  }
  if (published || contended) {
    await captureFailure(publicationFailures, () => syncDirectory(identityDirectory, operations))
  }
  await captureFailure(publicationFailures, () => operations.remove(temporary))
  throwFailures(publicationFailures, `repositoryId publication failed for ${location.repositoryIdPath}`)
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
