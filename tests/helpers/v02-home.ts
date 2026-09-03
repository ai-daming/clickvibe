/**
 * Shared fixture helper: activate a verified v0.2 config/state pair in a test
 * home by running the REAL upgrade machine (preview + apply with the offline
 * generation fence). No crafting of journal/marker bytes: the pairing the
 * runtime accepts is produced exactly as production produces it.
 *
 * Every `repos` entry must be (or will become) a real git repository with a
 * single `origin` remote; pass `deleteAfterActivation` to remove the clone
 * directory afterwards for missing-path scenarios (the runtime then fails
 * closed on that binding, per ADR-0009/#134 strict pairing).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  createOfflineV02GenerationFence,
  resetV02GenerationFenceForTest,
  V02_OFFLINE_HOST_DECLARATION,
} from '../../src/infra/v02-generation-fence.ts'
import { applyV02Upgrade } from '../../src/infra/v02-upgrade-execution.ts'
import { previewV02Upgrade } from '../../src/infra/v02-upgrade.ts'

const execFileAsync = promisify(execFile)

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim()
}

function testNonce(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Turn an existing (or new) directory into a minimal real git repository. */
export async function initFixtureRepository(repository: string): Promise<string> {
  await mkdir(repository, { recursive: true })
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  return repository
}

/** Create a minimal real git repository with a single `origin` remote. */
export async function makeFixtureRepository(parent: string, name: string): Promise<string> {
  const repository = join(parent, name)
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', `base ${name}`)
  await git(repository, 'remote', 'add', 'origin', `https://github.com/${name.split('-')[0]}/r.git`)
  return repository
}

export interface ActivateV02HomeOptions {
  worktreeRoot?: string
  fetchTtlSeconds?: number
  diagnosticsMaxBytes?: number
  /** Repository paths to delete after activation (missing-path scenarios). */
  deleteAfterActivation?: string[]
}

export async function activateV02Home(
  home: string,
  repos: Record<string, string>,
  options: ActivateV02HomeOptions = {},
): Promise<void> {
  const label = `activate-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`
  const root = join(home, '.clickvibe')
  await mkdir(root, { recursive: true })
  const lines = ['repos:']
  for (const [repoKey, path] of Object.entries(repos)) lines.push(`  ${repoKey}: ${path}`)
  if (options.worktreeRoot) lines.push(`worktreeRoot: ${options.worktreeRoot}`)
  if (options.fetchTtlSeconds !== undefined) lines.push(`fetchTtlSeconds: ${options.fetchTtlSeconds}`)
  if (options.diagnosticsMaxBytes !== undefined) lines.push(`diagnosticsMaxBytes: ${options.diagnosticsMaxBytes}`)
  await writeFile(join(root, 'config.yaml'), `${lines.join('\n')}\n`, { mode: 0o600 })

  resetV02GenerationFenceForTest()
  const primaryRemotes: Record<string, string> = {}
  for (const repoKey of Object.keys(repos)) primaryRemotes[repoKey] = 'origin'
  const fence = () =>
    createOfflineV02GenerationFence({
      declaration: V02_OFFLINE_HOST_DECLARATION,
      enumerateOldPluginProcesses: async () => [],
    })
  // One retry absorbs a deferred diagnostic write from a sibling test landing
  // between preview and the critical-section re-observation; a facts-changed
  // attempt writes nothing, so the retry is side-effect free.
  let result: { status: string } | undefined
  for (let attempt = 0; attempt < 2 && result?.status !== 'verified'; attempt += 1) {
    const preview = await previewV02Upgrade({
      home,
      baselineSha: testNonce(label),
      nonce: testNonce(`${label}-${attempt}`),
      choices: { primaryRemotes, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    if (preview.status !== 'previewed') throw new Error(`v0.2 activation preview failed: ${JSON.stringify(preview)}`)
    result = await applyV02Upgrade({ plan: preview.plan, fingerprint: preview.fingerprint, fence: fence() })
  }
  if (result?.status !== 'verified') throw new Error(`v0.2 activation failed: ${JSON.stringify(result)}`)
  // Return the process to the pre-upgrade fence mode so sibling tests in the
  // same process can still start tasks; production keeps v0.2-active.
  resetV02GenerationFenceForTest()
  for (const path of options.deleteAfterActivation ?? []) await rm(path, { recursive: true, force: true })
}

/** A fresh temp home plus real fixture repositories, activated as v0.2. */
export async function v02Home(
  repoKeys: string[],
  options: ActivateV02HomeOptions = {},
): Promise<{ home: string; repositories: Record<string, string> }> {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-home-'))
  const repositories: Record<string, string> = {}
  for (const repoKey of repoKeys) {
    repositories[repoKey] = await makeFixtureRepository(home, repoKey.replace('/', '-'))
  }
  await activateV02Home(home, repositories, options)
  return { home, repositories }
}
