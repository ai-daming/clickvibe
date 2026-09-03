/**
 * Active legacy-reader removal tests (ADR-0013 §6, disposition table rows
 * A2/A3/B1–B4, issue #137 AC3). After the v0.2 clean break the runtime must
 * not migrate or consult v0.1 state layouts, and the v0.1 repos-config writer
 * is gone: the project-import entry fails closed instead of writing.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { loadAllWorkflows } from '../src/infra/state.ts'
import { appendLog } from '../src/infra/state.ts'
import { importDshProject } from '../src/workflow/project-import.ts'

const execFileAsync = promisify(execFile)

async function git(cwd, ...args) {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim()
}

async function withTempHome(name, run) {
  const previous = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), `clickvibe-legacy-removal-${name}-`))
  process.env.HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test('v0.1 state layouts are observed as-is and never migrated', async () => {
  await withTempHome('no-migration', async (home) => {
    const state = join(home, '.clickvibe', 'state')
    await mkdir(join(state, 'archive'), { recursive: true })
    await writeFile(join(state, 'legacy-workflow.json'), '{"key":"o-r-9"}\n')
    await writeFile(join(state, 'archive', 'old.json'), '{"key":"o-r-8"}\n')

    const workflows = await loadAllWorkflows()
    assert.deepEqual(workflows, [])

    const entries = (await readdir(state)).sort()
    assert.deepEqual(entries, ['archive', 'legacy-workflow.json'], 'no v0.1 layout may be moved or deleted')
    const archived = await readFile(join(state, 'archive', 'old.json'), 'utf8')
    assert.equal(archived, '{"key":"o-r-8"}\n')
  })
})

test('taskless action logs append only under the current workflow key, never a legacy alias', async () => {
  await withTempHome('append-current-key', async (home) => {
    const state = join(home, '.clickvibe', 'state')
    const currentKey = 'issue-aXRzLW9yZ2FuaXphdGlvbi9yZXBv-9'
    const legacyAlias = 'its-organization-repo-9'
    await mkdir(join(state, legacyAlias), { recursive: true })
    await writeFile(join(state, legacyAlias, 'dev.log'), 'alias-only\n')

    await appendLog(currentKey, 'dev', '[clickvibe] current-channel-line')

    const current = await readFile(join(state, currentKey, 'dev.log'), 'utf8')
    assert.equal(current, '[clickvibe] current-channel-line\n')
    const alias = await readFile(join(state, legacyAlias, 'dev.log'), 'utf8')
    assert.equal(alias, 'alias-only\n', 'the v0.1 alias must not be consulted or extended')
  })
})

test('project import fails closed instead of writing a v0.1 repos mapping', async (t) => {
  const previous = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-legacy-removal-import-'))
  process.env.HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const root = join(home, '.clickvibe')
  await mkdir(root, { recursive: true })
  const before = '# frozen\nrepos:\n  existing/repo: /existing\n'
  await writeFile(join(root, 'config.yaml'), before)

  const repository = join(home, 'repo')
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')

  const result = await importDshProject(
    {
      shell: {
        resolve: (spec) => spec,
        async run() {
          return { exitCode: 0, stdout: { text: 'https://github.com/o/r.git\n' }, stderr: { text: '' } }
        },
      },
    },
    repository,
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /clean break|废弃/)

  const after = await readFile(join(root, 'config.yaml'), 'utf8')
  assert.equal(after, before, 'the v0.1 repos writer must not run')
})
