#!/usr/bin/env node
/**
 * Offline v0.1 -> v0.2 upgrade runner (ADR-0013 §5, v02-upgrade-protocol §12).
 *
 * Thin composition only: every machine check (plan fingerprint, upgrade lock,
 * generation fence, durable journal, recovery matrix) stays inside the
 * library. The operator flow is:
 *
 *   node scripts/upgrade-v0.2.mjs preview [--home DIR] [--primary o/r=origin] \
 *       [--exclude o/r=reason] > plan.json
 *   node scripts/upgrade-v0.2.mjs apply --plan plan.json --fingerprint <echo>
 *   node scripts/upgrade-v0.2.mjs recovery [--home DIR]
 *   node scripts/upgrade-v0.2.mjs resume|rollback --plan plan.json --fingerprint <echo>
 *
 * `preview` is zero-write and prints the plan JSON between markers; the
 * operator keeps that file. `apply`/`resume`/`rollback` require the operator
 * to echo the preview fingerprint verbatim; the echo is recorded in the
 * append-only authorization log before execution. Exit codes: 0 success,
 * 1 usage/error, 2 blocked or facts changed, 3 failed upgrade.
 */

import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  createOfflineV02GenerationFence,
  enumerateLegacyClickVibeProcesses,
  V02_OFFLINE_HOST_DECLARATION,
} from '../src/infra/v02-generation-fence.ts'
import { applyV02Upgrade } from '../src/infra/v02-upgrade-execution.ts'
import { previewV02UpgradeRecovery, resumeV02Upgrade, rollbackV02Upgrade } from '../src/infra/v02-upgrade-recovery.ts'
import { previewV02Upgrade, v02UpgradePlanFingerprint } from '../src/infra/v02-upgrade.ts'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'offline-runner-1'

function fail(message, code = 1) {
  console.error(String(message))
  process.exit(code)
}

async function baselineSha() {
  try {
    return (await execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim()
  } catch {
    fail('cannot determine the baseline SHA: `git rev-parse HEAD` failed inside the repository')
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = new Map()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const inline = token.indexOf('=')
    if (inline > 0) {
      flags.set(token.slice(2, inline), token.slice(inline + 1))
    } else {
      const value = rest[index + 1]
      if (value === undefined) fail(`missing value for ${token}`)
      flags.set(token.slice(2), value)
      index += 1
    }
  }
  return { command, flags }
}

function repeatable(flags, name) {
  const values = []
  for (const [key, value] of flags) if (key === name) values.push(value)
  return values
}

function parsePairAssignments(values, label) {
  const result = {}
  for (const value of values) {
    const split = value.indexOf('=')
    if (split <= 0) fail(`--${label} expects ${label === 'primary' ? 'owner/repo=remote' : 'owner/repo=reason'}`)
    result[value.slice(0, split)] = value.slice(split + 1)
  }
  return result
}

async function recordAuthorization(home, command, fingerprint) {
  const root = join(resolve(home), '.clickvibe')
  await mkdir(root, { recursive: true })
  await appendFile(
    join(root, 'upgrade-v0.2-authorization.log'),
    `${JSON.stringify({ at: new Date().toISOString(), entry: ENTRY, command, fingerprint })}\n`,
    'utf8',
  )
}

function offlineFence() {
  return createOfflineV02GenerationFence({ declaration: V02_OFFLINE_HOST_DECLARATION })
}

async function loadPlan(flags, command) {
  const planPath = flags.get('plan')
  if (!planPath) fail(`${command} requires --plan <plan.json saved from preview/recovery output>`)
  const fingerprint = flags.get('fingerprint')
  if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    fail(`${command} requires --fingerprint <the fingerprint you read in the preview output, echoed verbatim>`)
  }
  let plan
  try {
    plan = JSON.parse(await readFile(planPath, 'utf8'))
  } catch (reason) {
    fail(`cannot read the plan file: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  return { plan, fingerprint }
}

function printPreview(plan, fingerprint) {
  console.log(`fingerprint: ${fingerprint}`)
  console.log(`baselineSha: ${plan.baselineSha}`)
  console.log(`activeConfig: ${plan.paths.activeConfig}`)
  console.log(`configBackup: ${plan.paths.configBackup}`)
  console.log(`activeState: ${plan.paths.activeState}`)
  console.log(`stateBackup: ${plan.paths.stateBackup}`)
  console.log(`stagedState: ${plan.paths.stagedState}`)
  console.log(`journal: ${plan.paths.journal}`)
  console.log(
    `legacyState: ${plan.legacyState.status} (${plan.legacyState.fileCount} files, ${plan.legacyState.byteCount} bytes)`,
  )
  console.log(`hostActivity: oldPluginProcesses=${plan.hostActivity.oldPluginProcesses.length}`)
  for (const exclusion of plan.exclusions) console.log(`excluded: ${exclusion.repoKey} (${exclusion.reason})`)
  for (const binding of plan.bindings) {
    console.log(
      `binding: ${binding.container.id} -> ${binding.repository.localPath} (common-dir ${binding.realCommonDir}, repositoryId ${binding.repository.repositoryId}${binding.repositoryIdExisted ? '' : ' [new]'}, remote ${binding.repository.primaryRemote})`,
    )
  }
  for (const worktree of plan.worktrees) {
    const lines = worktree.porcelain.split('\n').filter((line) => line.startsWith('worktree ')).length
    console.log(`worktrees: ${worktree.repoKey} observes ${lines} registered worktree(s)`)
  }
  console.log('PLAN-JSON-BEGIN')
  console.log(JSON.stringify(plan, null, 2))
  console.log('PLAN-JSON-END')
  console.log(
    'Preview was zero-write. Save the plan JSON, then run apply with --fingerprint echoing the fingerprint above.',
  )
}

const { command, flags } = parseArgs(process.argv.slice(2))
const home = flags.get('home') ?? homedir()

try {
  if (command === 'preview') {
    const oldPluginProcesses = await enumerateLegacyClickVibeProcesses()
    const preview = await previewV02Upgrade({
      home,
      baselineSha: await baselineSha(),
      choices: { primaryRemotes: parsePairAssignments(repeatable(flags, 'primary'), 'primary'), exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses },
    })
    if (preview.status === 'previewed') {
      printPreview(preview.plan, preview.fingerprint)
    } else if (preview.status === 'blocked') {
      for (const item of preview.blocked) console.error(`blocked [${item.scope}] ${item.key}: ${item.error}`)
      console.error('Fix the facts or pass --exclude owner/repo=reason, then run preview again.')
      process.exit(2)
    } else {
      console.error('An unfinished upgrade journal exists; run the recovery command first.')
      process.exit(2)
    }
  } else if (command === 'recovery') {
    const recovery = await previewV02UpgradeRecovery({ home })
    if (recovery.status === 'recovery-previewed') {
      console.log(`fingerprint: ${recovery.fingerprint}`)
      console.log(`journal: ${recovery.plan.journal.path} (phase ${recovery.plan.journal.value.phase})`)
      for (const asset of recovery.plan.assets) console.log(`asset: ${asset.path} (${asset.kind})`)
      console.log('PLAN-JSON-BEGIN')
      console.log(JSON.stringify(recovery.plan, null, 2))
      console.log('PLAN-JSON-END')
      console.log('Save the plan JSON, then run resume or rollback with --fingerprint echoing the fingerprint above.')
    } else {
      console.error(`recovery unavailable (${recovery.status}): ${recovery.error}`)
      process.exit(2)
    }
  } else if (command === 'apply') {
    const { plan, fingerprint } = await loadPlan(flags, command)
    if (v02UpgradePlanFingerprint(plan) !== fingerprint) {
      fail('the echoed fingerprint does not match the supplied plan; authorization refused and nothing was written')
    }
    const planHome = dirname(plan.paths.root)
    await recordAuthorization(planHome, command, fingerprint)
    const result = await applyV02Upgrade({ plan, fingerprint, fence: offlineFence() })
    if (result.status === 'verified') {
      console.log(`verified: journal ${plan.paths.journal}`)
    } else if (result.status === 'facts-changed') {
      console.error('facts changed after authorization; the echo is void. Re-run preview and authorize again.')
      process.exit(2)
    } else {
      console.error(`upgrade failed: ${result.error} (journal ${plan.paths.journal}); run the recovery command`)
      process.exit(3)
    }
  } else if (command === 'resume' || command === 'rollback') {
    const { plan, fingerprint } = await loadPlan(flags, command)
    const planHome = dirname(plan.paths.root)
    await recordAuthorization(planHome, command, fingerprint)
    const options = { plan, fingerprint, fence: offlineFence() }
    const result = command === 'resume' ? await resumeV02Upgrade(options) : await rollbackV02Upgrade(options)
    if (result.status === 'verified' || result.status === 'rolled-back') {
      console.log(`${result.status}: journal ${plan.journal.path}`)
    } else {
      console.error(`${command} did not complete (${JSON.stringify(result)}); re-run the recovery command`)
      process.exit(3)
    }
  } else {
    fail(`unknown command: ${command ?? '(none)'}; expected preview | apply | recovery | resume | rollback`)
  }
} catch (reason) {
  fail(reason instanceof Error ? reason.message : String(reason))
}
