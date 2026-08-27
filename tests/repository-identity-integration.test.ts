import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  ensureRepositoryId,
  inspectRepositoryIdentityLocation,
  readRepositoryId,
  verifyProjectBindingRepository,
} from '../src/infra/repository-identity.ts'
import { createProjectBinding, parseClickVibeConfigV1 } from '../src/infra/project-binding.ts'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

async function initRepository(path: string): Promise<void> {
  await git(dirname(path), 'init', path)
  await git(path, 'config', 'user.name', 'clickvibe-test')
  await git(path, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(path, 'commit', '--allow-empty', '-m', 'base')
}

test('main checkout and linked worktree share one complete clone-stable repositoryId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-repository-id-'))
  const repository = join(root, 'repo')
  const worktree = join(root, 'linked')
  try {
    await initRepository(repository)
    await git(repository, 'worktree', 'add', '-b', 'linked-test', worktree)

    const ids = await Promise.all(Array.from({ length: 12 }, () => ensureRepositoryId(repository)))
    assert.equal(new Set(ids).size, 1)
    assert.match(ids[0], /^repo_[0-9a-f-]{36}$/)
    assert.equal(await readRepositoryId(worktree), ids[0])

    const mainLocation = await inspectRepositoryIdentityLocation(repository)
    const linkedLocation = await inspectRepositoryIdentityLocation(worktree)
    assert.equal(mainLocation.commonDir, linkedLocation.commonDir)
    assert.equal(await readFile(mainLocation.repositoryIdPath, 'utf8'), `${ids[0]}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('independent clones with the same remote get different repositoryIds and moving a clone keeps its ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-independent-clones-'))
  const source = join(root, 'source')
  const remote = join(root, 'remote.git')
  const first = join(root, 'first')
  const second = join(root, 'second')
  const moved = join(root, 'moved')
  try {
    await initRepository(source)
    await execFileAsync('git', ['init', '--bare', remote])
    await git(source, 'remote', 'add', 'origin', remote)
    await git(source, 'push', 'origin', 'HEAD:main')
    await execFileAsync('git', ['clone', remote, first])
    await execFileAsync('git', ['clone', remote, second])

    const firstId = await ensureRepositoryId(first)
    const secondId = await ensureRepositoryId(second)
    assert.notEqual(firstId, secondId)
    assert.equal(
      (await git(first, 'remote', 'get-url', 'origin')).stdout,
      (await git(second, 'remote', 'get-url', 'origin')).stdout,
    )

    await rename(first, moved)
    assert.equal(await readRepositoryId(moved), firstId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('binding verification fails closed on repositoryId mismatch and missing primary remote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-binding-verify-'))
  const repository = join(root, 'repo')
  try {
    await initRepository(repository)
    const repositoryId = await ensureRepositoryId(repository)
    const binding = createProjectBinding({
      container: { provider: 'github', instance: 'github.com', id: 'o/r' },
      repository: { repositoryId, localPath: repository, primaryRemote: 'origin' },
    })

    await assert.rejects(verifyProjectBindingRepository(binding), /primaryRemote.*origin.*does not exist/)
    await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    const verified = await verifyProjectBindingRepository(binding)
    assert.equal(verified.repositoryId, repositoryId)
    assert.equal(verified.primaryRemoteUrl, 'https://github.com/o/r.git')
    await assert.rejects(
      verifyProjectBindingRepository(
        createProjectBinding({
          container: binding.container,
          repository: { ...binding.repository, repositoryId: 'repo_123e4567-e89b-42d3-a456-426614174000' },
        }),
      ),
      /repositoryId mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copying a clone copies its sidecar and target config rejects the duplicate repositoryId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-copied-clone-'))
  const original = join(root, 'original')
  const copied = join(root, 'copied')
  try {
    await initRepository(original)
    const repositoryId = await ensureRepositoryId(original)
    await cp(original, copied, { recursive: true })
    assert.equal(await readRepositoryId(copied), repositoryId)
    const first = createProjectBinding({
      container: { provider: 'github', instance: 'github.com', id: 'o/first' },
      repository: { repositoryId, localPath: original, primaryRemote: 'origin' },
    })
    const second = createProjectBinding({
      container: { provider: 'github', instance: 'github.com', id: 'o/second' },
      repository: { repositoryId, localPath: copied, primaryRemote: 'origin' },
    })
    assert.throws(
      () =>
        parseClickVibeConfigV1({
          schemaVersion: 1,
          worktreeRoot: join(root, 'worktrees'),
          projectBindings: [first, second],
        }),
      /repositoryId.*unique/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bare repositories, submodules, symlink and malformed repositoryId files are rejected without overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-repository-id-invalid-'))
  const bare = join(root, 'bare.git')
  const parent = join(root, 'parent')
  const child = join(root, 'child')
  const submodule = join(parent, 'submodule')
  try {
    await execFileAsync('git', ['init', '--bare', bare])
    await assert.rejects(ensureRepositoryId(bare), /bare repository/)

    await initRepository(parent)
    await initRepository(child)
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'submodule')
    await assert.rejects(ensureRepositoryId(submodule), /submodule/)

    const location = await inspectRepositoryIdentityLocation(parent)
    await mkdir(dirname(location.repositoryIdPath), { recursive: true })
    const target = join(root, 'outside-id')
    await writeFile(target, 'repo_123e4567-e89b-42d3-a456-426614174000\n')
    await symlink(target, location.repositoryIdPath)
    await assert.rejects(ensureRepositoryId(parent), /symlink/)
    assert.equal(await readFile(target, 'utf8'), 'repo_123e4567-e89b-42d3-a456-426614174000\n')

    await rm(location.repositoryIdPath)
    await writeFile(location.repositoryIdPath, 'partial')
    await assert.rejects(ensureRepositoryId(parent), /invalid repositoryId/)
    assert.equal(await readFile(location.repositoryIdPath, 'utf8'), 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
