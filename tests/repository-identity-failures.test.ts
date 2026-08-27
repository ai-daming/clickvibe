import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import type {
  RepositoryIdentityPublicationOperations,
  RepositoryIdentityWriteHandle,
} from '../src/infra/repository-identity.ts'
import { ensureRepositoryId, inspectRepositoryIdentityLocation } from '../src/infra/repository-identity.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

type FailureStep = 'temp-write' | 'temp-fsync' | 'link' | 'directory-fsync'

function failureOperations(step: FailureStep): RepositoryIdentityPublicationOperations {
  return {
    async openTemporary(path: string): Promise<RepositoryIdentityWriteHandle> {
      const handle = await open(path, 'wx', 0o600)
      return {
        async writeFile(value: string) {
          if (step === 'temp-write') throw new Error(`forced ${step}`)
          await handle.writeFile(value, 'utf8')
        },
        async sync() {
          if (step === 'temp-fsync') throw new Error(`forced ${step}`)
          await handle.sync()
        },
        close: () => handle.close(),
      }
    },
    async publish(temporary: string, destination: string) {
      if (step === 'link') throw new Error(`forced ${step}`)
      await link(temporary, destination)
    },
    async openDirectory(path: string) {
      const handle = await open(path, 'r')
      return {
        async sync() {
          if (step === 'directory-fsync') throw new Error(`forced ${step}`)
          await handle.sync()
        },
        close: () => handle.close(),
      }
    },
    remove: unlink,
  }
}

test('every repositoryId publication failure leaves the final file complete or absent and retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-repository-id-failures-'))
  try {
    for (const step of ['temp-write', 'temp-fsync', 'link', 'directory-fsync'] as const) {
      const repository = join(root, step)
      await initRepository(repository)
      const location = await inspectRepositoryIdentityLocation(repository)
      await assert.rejects(ensureRepositoryId(repository, failureOperations(step)), new RegExp(`forced ${step}`))

      const raw = await readFile(location.repositoryIdPath, 'utf8').catch((reason) => {
        if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw reason
      })
      if (raw !== null) assert.match(raw, /^repo_[0-9a-f-]{36}\n$/)
      const entries = await readdir(dirname(location.repositoryIdPath))
      assert.equal(
        entries.some((entry) => entry.startsWith('.repository-id.tmp-')),
        false,
        `${step} left a temporary file`,
      )
      const recovered = await ensureRepositoryId(repository)
      assert.equal(await readFile(location.repositoryIdPath, 'utf8'), `${recovered}\n`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const workerSource = `
import { existsSync } from 'node:fs'
import { ensureRepositoryId } from './src/infra/repository-identity.ts'
console.log('ready')
while (!existsSync(process.env.START_GATE)) await new Promise((resolve) => setTimeout(resolve, 5))
try {
  console.log(JSON.stringify({ ok: true, id: await ensureRepositoryId(process.env.TARGET_REPOSITORY) }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
}
`

async function startRepositoryIdWorker(repository: string, gate: string) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', workerSource], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET_REPOSITORY: repository, START_GATE: gate },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const ready = await output.next()
  assert.equal(ready.value, 'ready', stderr)
  return { child, output, stderr: () => stderr }
}

test('separate Node processes concurrently publish one complete repositoryId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-repository-id-processes-'))
  const repository = join(root, 'repo')
  const gate = join(root, 'start')
  const workers: Awaited<ReturnType<typeof startRepositoryIdWorker>>[] = []
  try {
    await initRepository(repository)
    for (let index = 0; index < 8; index += 1) workers.push(await startRepositoryIdWorker(repository, gate))
    await writeFile(gate, 'go')
    const results = await Promise.all(
      workers.map(async (worker) => {
        const line = await worker.output.next()
        assert.equal(line.done, false, worker.stderr())
        return JSON.parse(line.value) as { ok: boolean; id?: string; error?: string }
      }),
    )
    assert.ok(
      results.every((result) => result.ok),
      JSON.stringify(results),
    )
    assert.equal(new Set(results.map((result) => result.id)).size, 1)
    const location = await inspectRepositoryIdentityLocation(repository)
    assert.equal(await readFile(location.repositoryIdPath, 'utf8'), `${results[0].id}\n`)
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill()
      if (worker.child.exitCode === null) await once(worker.child, 'exit')
    }
    await rm(root, { recursive: true, force: true })
  }
})
