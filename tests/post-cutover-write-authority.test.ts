/**
 * Post-cutover write authority (ADR-0009 D1/D6, protocol §1, issue #137 AC3/AC5):
 * once a VERIFIED journal and the v0.2 state marker own the root, current-format
 * runtime writers (workflow persistence, task/action logs) are the rightful
 * owners and must be admitted. Partial upgrades, torn journals, and drift
 * (verified without marker, or marker without journal) stay fail-closed.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendLog } from '../src/infra/state.ts'
import {
  assertActiveStateWriteAllowed,
  isV02GenerationViolation,
  resetV02GenerationFenceForTest,
} from '../src/infra/v02-generation-fence.ts'

interface RootShape {
  journal?: { phase: string; planFingerprint?: string }
  marker?: boolean
}

async function ownedRoot(shape: RootShape): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-write-authority-'))
  const root = join(home, '.clickvibe', 'state')
  await mkdir(root, { recursive: true })
  if (shape.journal) {
    await writeFile(
      join(home, '.clickvibe', 'upgrade-v0.2.json'),
      `${JSON.stringify({ schemaVersion: 1, phase: shape.journal.phase, planFingerprint: shape.journal.planFingerprint ?? 'f'.repeat(64) })}\n`,
    )
  }
  if (shape.marker) {
    await writeFile(join(root, '.clickvibe-state.json'), '{"schemaVersion":1,"generation":"v0.2"}\n')
  }
  return root
}

async function withRoots(shape: RootShape, run: (root: string, home: string) => Promise<void>) {
  const root = await ownedRoot(shape)
  const home = join(root, '..', '..')
  const previous = process.env.HOME
  process.env.HOME = home
  resetV02GenerationFenceForTest()
  try {
    await run(root, home)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    resetV02GenerationFenceForTest()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const workflow = { key: 'issue-dw8v', repoKey: 'o/r', url: 'https://github.com/o/r/issues/8' }

test('a verified journal with marker admits current-format runtime writers', async () => {
  await withRoots({ journal: { phase: 'verified' }, marker: true }, async (root) => {
    await appendLog(workflow.key, 'dev', '[clickvibe] post-cutover action note')
    assertActiveStateWriteAllowed(root)
  })
})

test('a partial or torn journal keeps every writer fail-closed', async () => {
  for (const phase of ['preparing', 'prepared', 'cutting-over', 'failed', 'unknown']) {
    await withRoots({ journal: { phase }, marker: false }, async () => {
      await assert.rejects(appendLog(workflow.key, 'dev', 'x'), (reason: unknown) => isV02GenerationViolation(reason))
    })
  }
})

test('drift between the journal and the marker stays fail-closed', async () => {
  await withRoots({ journal: { phase: 'verified' }, marker: false }, async () => {
    await assert.rejects(appendLog(workflow.key, 'dev', 'x'), (reason: unknown) => isV02GenerationViolation(reason))
  })
  await withRoots({ journal: undefined, marker: true }, async () => {
    await assert.rejects(appendLog(workflow.key, 'dev', 'x'), (reason: unknown) => isV02GenerationViolation(reason))
  })
})

test('a rolled-back or clean root keeps the pre-upgrade write semantics', async () => {
  await withRoots({ journal: { phase: 'rolled_back' }, marker: false }, async () => {
    await appendLog(workflow.key, 'dev', '[clickvibe] rolled-back root stays writable')
  })
  await withRoots({ journal: undefined, marker: false }, async () => {
    await appendLog(workflow.key, 'dev', '[clickvibe] clean root stays writable')
  })
})
