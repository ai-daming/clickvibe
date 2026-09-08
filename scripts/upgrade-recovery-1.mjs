#!/usr/bin/env node
import { fingerprintWorkItemContract } from '../src/workflow/work-item-contract.ts'
/** ADR-0017 offline entry. Preview writes only the requested private plan artifact, never active state.
 * preview --plan FILE [--home HOME]
 * apply|resume|rollback --plan FILE --fingerprint HASH --host-stopped host-stopped-and-restart-disabled
 */
import { execFileSync } from 'node:child_process'
import { open, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  previewRecoveryUpgrade,
  applyRecoveryUpgrade,
  resumeRecoveryUpgrade,
  rollbackRecoveryUpgrade,
} from '../src/infra/recovery-upgrade.ts'
import { verifyRecoveryPlan } from '../src/infra/recovery-upgrade-plan.ts'
import { createOfflineV02GenerationFence, V02_OFFLINE_HOST_DECLARATION } from '../src/infra/v02-generation-fence.ts'

try {
  const [command, ...args] = process.argv.slice(2)
  if (!['preview', 'apply', 'resume', 'rollback'].includes(command))
    throw new Error(
      'usage: preview|apply|resume|rollback --plan FILE [--home HOME] [--fingerprint HASH --host-stopped host-stopped-and-restart-disabled]',
    )
  const flags = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--plan', '--home', '--fingerprint', '--host-stopped'].includes(args[i]) ||
      args[i + 1] === undefined ||
      flags.has(args[i])
    )
      throw new Error('invalid or repeated argument')
    flags.set(args[i], args[i + 1])
  }
  if (!flags.has('--plan')) throw new Error('--plan FILE is required')
  const planPath = resolve(flags.get('--plan'))
  if (command === 'preview') {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const baselineSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const plan = await previewRecoveryUpgrade({
      home: resolve(flags.get('--home') ?? homedir()),
      baselineSha,
      fingerprintOf: fingerprintWorkItemContract,
    })
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600, flag: 'wx' })
    console.log(
      JSON.stringify({
        phase: 'previewed',
        planPath,
        fingerprint: plan.fingerprint,
        sourceFiles: Object.keys(plan.sourceFiles).length,
        target: join(plan.home, '.clickvibe', 'state-recovery-1'),
      }),
    )
  } else {
    if (flags.get('--host-stopped') !== V02_OFFLINE_HOST_DECLARATION)
      throw new Error('explicit --host-stopped declaration is required before any write')
    const plan = JSON.parse(await readFile(planPath, 'utf8'))
    verifyRecoveryPlan(plan, fingerprintWorkItemContract)
    if (flags.get('--fingerprint') !== plan.fingerprint) throw new Error('authorization fingerprint mismatch')
    if (flags.has('--home') && resolve(flags.get('--home')) !== plan.home)
      throw new Error('home differs from the authorized plan')
    const audit = await open(join(plan.home, '.clickvibe', 'recovery-authorization.log'), 'a', 0o600)
    try {
      await audit.writeFile(
        `${JSON.stringify({ at: new Date().toISOString(), command, fingerprint: plan.fingerprint, entry: 'offline-recovery-1' })}\n`,
      )
      await audit.sync()
    } finally {
      await audit.close()
    }
    const options = {
      fingerprintOf: fingerprintWorkItemContract,
      home: plan.home,
      plan,
      fingerprint: plan.fingerprint,
      fence: createOfflineV02GenerationFence({ declaration: V02_OFFLINE_HOST_DECLARATION }),
    }
    const result = await (command === 'apply'
      ? applyRecoveryUpgrade(options)
      : command === 'resume'
        ? resumeRecoveryUpgrade(options)
        : rollbackRecoveryUpgrade(options))
    console.log(JSON.stringify({ phase: result.phase, fingerprint: result.fingerprint }))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'offline recovery command failed')
  process.exitCode = 1
}
