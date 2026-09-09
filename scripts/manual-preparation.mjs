#!/usr/bin/env node
// Offline ADR-0018 runbook companion. It is never registered as a host/product command.
import {
  readBootIdentity,
  previewManualPreparation,
  publishManualPreparation,
} from '../src/infra/manual-preparation.ts'

const [action, ...args] = process.argv.slice(2)
try {
  if (action === 'boot-id' && args.length === 0) console.log(await readBootIdentity())
  else if (action === 'preview' && args.length === 4) {
    const [home, key, evidence, directory] = args
    console.log(await previewManualPreparation({ home, key, evidence, directory }))
  } else if (action === 'publish' && args.length === 3) {
    const [directory, fingerprint, evidence] = args
    await publishManualPreparation(directory, fingerprint, evidence)
    console.log('settled and paused; inspect readback, then request new authorization')
  } else
    throw new Error('usage: boot-id | preview HOME KEY EVIDENCE NEW_DIRECTORY | publish DIRECTORY FINGERPRINT EVIDENCE')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'manual preparation failed; keep paused')
  process.exitCode = 1
}
