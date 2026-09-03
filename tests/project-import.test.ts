import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleCommand } from '../src/workflow/handlers.ts'
import { importDshProject, parseGithubRepoKey } from '../src/workflow/project-import.ts'

test('GitHub remote parser accepts HTTPS and SSH forms and rejects invalid mappings', () => {
  assert.equal(parseGithubRepoKey('https://github.com/ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('git@github.com:ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('ssh://git@github.com/ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('https://gitlab.com/ai-daming/clickvibe.git'), null)
  assert.equal(parseGithubRepoKey('not a remote'), null)
})

test('project import fails closed with the clean-break refusal and never writes config', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-import-'))
  process.env.HOME = tempHome
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  })

  await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
  const configPath = join(tempHome, '.clickvibe', 'config.yaml')
  const before = '# keep this comment\nrepos:\n  existing/repo: /existing\nfetchTtlSeconds: 45\n'
  await writeFile(configPath, before)

  const result = await importDshProject(
    {
      shell: {
        resolve: (spec: unknown) => spec,
        async run() {
          return {
            exitCode: 0,
            stdout: { text: 'git@github.com:ai-daming/clickvibe.git\n' },
            stderr: { text: '' },
          }
        },
      },
    } as never,
    '/work/clickvibe',
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /clean break|废弃/)
  assert.equal(await readFile(configPath, 'utf8'), before, 'the v0.1 repos writer must not run')
})

test('project import reports non-git and invalid remotes without writing config', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-invalid-'))
  process.env.HOME = tempHome
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  })

  const configDir = join(tempHome, '.clickvibe')
  const configPath = join(configDir, 'config.yaml')
  await mkdir(configDir, { recursive: true })
  await writeFile(configPath, 'repos: {}\n')
  const failed = await importDshProject(
    {
      shell: {
        resolve: (spec: unknown) => spec,
        async run() {
          return { exitCode: 128, stdout: { text: '' }, stderr: { text: 'not a git repository' } }
        },
      },
    } as never,
    '/work/plain',
  )
  assert.equal(failed.ok, false)
  assert.match(failed.ok ? '' : failed.error, /不是可导入的 git 仓库/)
  assert.equal(await readFile(configPath, 'utf8'), 'repos: {}\n')

  const invalidRemote = await importDshProject(
    {
      shell: {
        resolve: (spec: unknown) => spec,
        async run() {
          return { exitCode: 0, stdout: { text: 'https://gitlab.com/o/r.git' }, stderr: { text: '' } }
        },
      },
    } as never,
    '/work/gitlab',
  )
  assert.deepEqual(invalidRemote, { ok: false, error: 'origin 不是可识别的 GitHub 仓库地址' })
  assert.equal(await readFile(configPath, 'utf8'), 'repos: {}\n')
})

test('projects command surfaces the refusal and enforces request trust', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-command-'))
  process.env.HOME = tempHome
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  })

  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      async run() {
        return {
          exitCode: 0,
          stdout: { text: 'https://github.com/ai-daming/clickvibe.git' },
          stderr: { text: '' },
        }
      },
    },
  }
  const trustedReq = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-clickvibe-request': '1' },
  }
  const imported = await handleCommand(ctx as never, trustedReq as never, {
    command: 'projects',
    importPath: '/work/clickvibe',
  })
  assert.equal(imported.status, 400, JSON.stringify(imported.body))
  assert.equal((imported.body as { ok: boolean }).ok, false)
  assert.match(String((imported.body as { error?: string }).error), /clean break|废弃/)

  const rejected = await handleCommand(ctx as never, { socket: {}, headers: {} } as never, {
    command: 'projects',
    importPath: '/work/other',
  })
  assert.equal(rejected.status, 403)
})
