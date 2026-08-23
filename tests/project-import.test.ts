import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import { handleCommand } from '../src/workflow/handlers.ts'
import { importDshProject, parseGithubRepoKey } from '../src/workflow/project-import.ts'

test('GitHub remote parser accepts HTTPS and SSH forms and rejects invalid mappings', () => {
  assert.equal(parseGithubRepoKey('https://github.com/ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('git@github.com:ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('ssh://git@github.com/ai-daming/clickvibe.git'), 'ai-daming/clickvibe')
  assert.equal(parseGithubRepoKey('https://gitlab.com/ai-daming/clickvibe.git'), null)
  assert.equal(parseGithubRepoKey('not a remote'), null)
})

test('project import writes one repo mapping while preserving the rest of config', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-import-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      '# keep this comment\nrepos:\n  existing/repo: /existing\nfetchTtlSeconds: 45\n',
    )
    const commands: Array<{ command: string; workdir?: string }> = []
    const result = await importDshProject(
      {
        shell: {
          resolve: (spec: unknown) => spec,
          async run(spec: { command: string; workdir?: string }) {
            commands.push(spec)
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

    assert.deepEqual(result, { ok: true, repoKey: 'ai-daming/clickvibe' })
    assert.equal(commands.length, 1)
    assert.deepEqual(commands[0], {
      command: 'git remote get-url origin',
      workdir: '/work/clickvibe',
      stdin: undefined,
      timeoutMs: 10_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/work/clickvibe' },
    })
    const raw = await readFile(join(tempHome, '.clickvibe', 'config.yaml'), 'utf8')
    assert.match(raw, /# keep this comment/)
    const parsed = parseYaml(raw) as { repos: Record<string, string>; fetchTtlSeconds: number }
    assert.deepEqual(parsed.repos, {
      'existing/repo': '/existing',
      'ai-daming/clickvibe': '/work/clickvibe',
    })
    assert.equal(parsed.fetchTtlSeconds, 45)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('project import never overwrites an existing repoKey or invalid config', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-idempotent-'))
  process.env.HOME = tempHome
  try {
    const configDir = join(tempHome, '.clickvibe')
    const configPath = join(configDir, 'config.yaml')
    await mkdir(configDir, { recursive: true })
    await writeFile(configPath, 'repos:\n  ai-daming/clickvibe: /original\n')
    const ctx = {
      shell: {
        resolve: (spec: unknown) => spec,
        async run() {
          return {
            exitCode: 0,
            stdout: { text: 'https://github.com/ai-daming/clickvibe.git\n' },
            stderr: { text: '' },
          }
        },
      },
    }

    const duplicate = await importDshProject(ctx as never, '/replacement')
    assert.deepEqual(duplicate, { ok: false, error: '项目 ai-daming/clickvibe 已配置，不会覆盖现有路径' })
    assert.match(await readFile(configPath, 'utf8'), /\/original/)

    await writeFile(configPath, 'repos: [broken')
    const invalid = await importDshProject(ctx as never, '/replacement')
    assert.equal(invalid.ok, false)
    assert.match(invalid.ok ? '' : invalid.error, /config.yaml 无法解析/)
    assert.equal(await readFile(configPath, 'utf8'), 'repos: [broken')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('project import reports non-git and invalid remotes without writing config', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-invalid-'))
  process.env.HOME = tempHome
  try {
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
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('projects command imports through the existing response envelope and enforces request trust', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-project-command-'))
  process.env.HOME = tempHome
  try {
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
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.deepEqual(imported.body, {
      ok: true,
      action: 'projects',
      text: '已配置的项目:\n- ai-daming/clickvibe → /work/clickvibe(路径不可用)',
      projects: [{ repoKey: 'ai-daming/clickvibe', path: '/work/clickvibe', available: false }],
    })

    const rejected = await handleCommand(ctx as never, { socket: {}, headers: {} } as never, {
      command: 'projects',
      importPath: '/work/other',
    })
    assert.equal(rejected.status, 403)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
