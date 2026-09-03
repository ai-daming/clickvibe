import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkItemContractSnapshot } from '../src/infra/contracts.ts'
import {
  type ContractPublicationCheckpoint,
  createRawArtifactRef,
  publishWorkItemContractCapture,
  readCurrentWorkItemContract,
  workItemContractPaths,
} from '../src/infra/work-item-contract-store.ts'
import { fingerprintWorkItemContract } from '../src/workflow/work-item-contract.ts'

const workItem = {
  provider: 'github',
  instance: 'github.com',
  container: 'ai-daming/clickvibe',
  id: '136',
}

function raw(capturedAt: string, sourceVersion: string, body = 'goal'): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, capturedAt, sourceVersion, item: { body } }), 'utf8')
}

function snapshot(
  root: string,
  bytes: Buffer,
  capturedAt: string,
  sourceVersion: string,
  goal = 'goal',
): WorkItemContractSnapshot {
  const value: WorkItemContractSnapshot = {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    workItem,
    sourceVersion,
    goal: { state: 'known', value: goal },
    acceptanceCriteria: { state: 'known', value: [{ description: 'works', verificationAuthority: 'agent' }] },
    dependencies: { state: 'known', value: [] },
    nonGoals: { state: 'known', value: [] },
    constraints: { state: 'known', value: [] },
    architectureImpact: 'L3',
    fingerprint: 'wic1_pending',
    capturedAt,
    rawArtifact: createRawArtifactRef(workItem, bytes, root),
  }
  value.fingerprint = fingerprintWorkItemContract(value)
  return value
}

const fingerprintOf = (value: WorkItemContractSnapshot) => fingerprintWorkItemContract(value)
const compareSourceVersion = (left: string, right: string) => left.localeCompare(right)

test('publishes and reads one exact-byte verified immutable contract bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = raw('2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z')
  const expected = snapshot(root, bytes, '2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z')

  const published = await publishWorkItemContractCapture({
    root,
    workItem,
    raw: bytes,
    snapshot: expected,
    fingerprintOf,
    compareSourceVersion,
  })
  assert.equal(published.state, 'known')
  assert.equal(published.status, 'published')

  const current = await readCurrentWorkItemContract({ root, workItem, fingerprintOf })
  assert.equal(current.state, 'known')
  if (current.state !== 'known') return
  assert.deepEqual(current.raw, bytes)
  assert.deepEqual(current.snapshot, expected)
  assert.deepEqual(await readFile(current.snapshot.rawArtifact.path), bytes)
})

test('raw byte damage and unknown versions are unknown and never interpreted as empty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-damage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = raw('2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z')
  const expected = snapshot(root, bytes, '2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z')
  await publishWorkItemContractCapture({
    root,
    workItem,
    raw: bytes,
    snapshot: expected,
    fingerprintOf,
    compareSourceVersion,
  })
  await writeFile(expected.rawArtifact.path, Buffer.from('damaged'))
  assert.deepEqual(await readCurrentWorkItemContract({ root, workItem, fingerprintOf }), {
    state: 'unknown',
    reason: 'raw-content-hash-mismatch',
  })

  const paths = workItemContractPaths(root, workItem)
  await rm(paths.contract, { recursive: true, force: true })
  await mkdir(paths.contract, { recursive: true })
  await writeFile(paths.current, JSON.stringify({ schemaVersion: 2, captureId: 'future', fingerprint: 'wic2_future' }))
  assert.deepEqual(await readCurrentWorkItemContract({ root, workItem, fingerprintOf }), {
    state: 'unknown',
    reason: 'unknown-current-version',
  })
})

test('concurrent publication serializes by Work Item and preserves the newer source version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const olderRaw = raw('2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z', 'old')
  const newerRaw = raw('2026-09-03T00:00:03Z', '2026-09-03T00:00:02Z', 'new')
  const older = snapshot(root, olderRaw, '2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z', 'old')
  const newer = snapshot(root, newerRaw, '2026-09-03T00:00:03Z', '2026-09-03T00:00:02Z', 'new')

  await Promise.all([
    publishWorkItemContractCapture({
      root,
      workItem,
      raw: newerRaw,
      snapshot: newer,
      fingerprintOf,
      compareSourceVersion,
    }),
    publishWorkItemContractCapture({
      root,
      workItem,
      raw: olderRaw,
      snapshot: older,
      fingerprintOf,
      compareSourceVersion,
    }),
  ])
  const current = await readCurrentWorkItemContract({ root, workItem, fingerprintOf })
  assert.equal(current.state, 'known')
  if (current.state === 'known') assert.equal(current.snapshot.sourceVersion, newer.sourceVersion)
})

test('same provider version may publish new non-contract evidence when the fingerprint is unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstRaw = raw('first', '2026-09-03T00:00:00Z')
  const secondRaw = raw('second', '2026-09-03T00:00:00Z')
  const first = snapshot(root, firstRaw, '2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z')
  const second = snapshot(root, secondRaw, '2026-09-03T00:00:02Z', '2026-09-03T00:00:00Z')
  second.fingerprint = first.fingerprint
  const options = { root, workItem, fingerprintOf: () => first.fingerprint, compareSourceVersion }
  assert.equal((await publishWorkItemContractCapture({ ...options, raw: firstRaw, snapshot: first })).state, 'known')
  const published = await publishWorkItemContractCapture({ ...options, raw: secondRaw, snapshot: second })
  assert.equal(published.state, 'known')
  if (published.state === 'known') assert.equal(published.raw.equals(secondRaw), true)
})

test('every publication crash boundary leaves either the complete old or complete new bundle current', async (t) => {
  const boundaries: ContractPublicationCheckpoint[] = [
    'before-raw-write',
    'after-raw-write',
    'after-snapshot-write',
    'before-capture-rename',
    'after-capture-rename',
    'after-captures-fsync',
    'before-pointer-temp-write',
    'after-pointer-temp-write',
    'before-pointer-rename',
    'after-pointer-rename',
    'after-contract-fsync',
  ]
  for (const boundary of boundaries) {
    await t.test(boundary, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `clickvibe-contract-${boundary}-`))
      subtest.after(() => rm(root, { recursive: true, force: true }))
      const oldRaw = raw('2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z', 'old')
      const newRaw = raw('2026-09-03T00:00:03Z', '2026-09-03T00:00:02Z', 'new')
      const oldSnapshot = snapshot(root, oldRaw, '2026-09-03T00:00:01Z', '2026-09-03T00:00:00Z', 'old')
      const newSnapshot = snapshot(root, newRaw, '2026-09-03T00:00:03Z', '2026-09-03T00:00:02Z', 'new')
      await publishWorkItemContractCapture({
        root,
        workItem,
        raw: oldRaw,
        snapshot: oldSnapshot,
        fingerprintOf,
        compareSourceVersion,
      })

      await assert.rejects(
        publishWorkItemContractCapture({
          root,
          workItem,
          raw: newRaw,
          snapshot: newSnapshot,
          fingerprintOf,
          compareSourceVersion,
          checkpoint(name) {
            if (name === boundary) throw new Error(`simulated crash at ${name}`)
          },
        }),
        /simulated crash/,
      )
      const current = await readCurrentWorkItemContract({ root, workItem, fingerprintOf })
      assert.equal(current.state, 'known')
      if (current.state !== 'known') return
      const pointerWasReplaced = boundary === 'after-pointer-rename' || boundary === 'after-contract-fsync'
      assert.equal(current.snapshot.fingerprint, pointerWasReplaced ? newSnapshot.fingerprint : oldSnapshot.fingerprint)
      assert.equal(current.raw.equals(pointerWasReplaced ? newRaw : oldRaw), true)
    })
  }
})
