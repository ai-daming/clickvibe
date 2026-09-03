import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { WorkItemContractSnapshot } from '../src/infra/contracts.ts'
import {
  canonicalWorkItemContractBytes,
  fingerprintWorkItemContract,
  normalizeContractText,
} from '../src/workflow/work-item-contract.ts'

const workItem = {
  provider: 'github',
  instance: 'github.com',
  container: 'ai-daming/clickvibe',
  id: '136',
}

function contract(
  overrides: Partial<WorkItemContractSnapshot> = {},
): Omit<WorkItemContractSnapshot, 'fingerprint'> & { fingerprint?: WorkItemContractSnapshot['fingerprint'] } {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    workItem,
    sourceVersion: '2026-09-03T00:00:00Z',
    goal: { state: 'known', value: 'Ship\r\ncontract  \r\n' },
    acceptanceCriteria: {
      state: 'known',
      value: [
        { description: 'Human check', verificationAuthority: 'human' },
        { description: 'Agent check', verificationAuthority: 'agent' },
      ],
    },
    dependencies: {
      state: 'known',
      value: [{ ...workItem, id: '137' }],
    },
    nonGoals: { state: 'unknown', reason: 'missing' },
    constraints: { state: 'known', value: ['No  double spaces'] },
    architectureImpact: 'L3',
    capturedAt: '2026-09-03T00:00:01Z',
    rawArtifact: {
      artifactId: 'capture1_raw',
      kind: 'issue-snapshot',
      path: 'raw.json',
      contentHash: 'sha256-v1_raw',
      redaction: 'none',
    },
    ...overrides,
  }
}

test('canonical v1 matches the cross-language golden bytes and wic1 fingerprint', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/work-item-contract-v1.json', import.meta.url), 'utf8'),
  ) as { canonicalUtf8: string; fingerprint: string }
  const input = contract()
  assert.equal(canonicalWorkItemContractBytes(input).toString('utf8'), fixture.canonicalUtf8)
  assert.equal(fingerprintWorkItemContract(input), fixture.fingerprint)
})

test('canonical text normalizes NFC, line endings and line tails but preserves inline whitespace', () => {
  assert.equal(normalizeContractText('\r\ne\u0301  \rline\t \r\n'), 'é\nline')
  assert.equal(normalizeContractText('A  B\tC'), 'A  B\tC')
  assert.throws(() => normalizeContractText('\ud800'), /Unicode scalar/)
})

test('metadata and list order do not change the fingerprint', () => {
  const baseline = contract()
  const reordered = contract({
    sourceVersion: 'later',
    capturedAt: 'later',
    architectureImpact: 'L0',
    acceptanceCriteria: {
      state: 'known',
      value: [...(baseline.acceptanceCriteria.state === 'known' ? baseline.acceptanceCriteria.value : [])].reverse(),
    },
    rawArtifact: { ...baseline.rawArtifact, contentHash: 'sha256-v1_changed' },
  })
  assert.equal(fingerprintWorkItemContract(reordered), fingerprintWorkItemContract(baseline))
})

test('every canonical contract field changes the fingerprint and unknown differs from known empty', () => {
  const baseline = contract()
  const variants = [
    contract({ goal: { state: 'known', value: 'Changed' } }),
    contract({
      acceptanceCriteria: { state: 'known', value: [{ description: 'Changed', verificationAuthority: 'agent' }] },
    }),
    contract({ dependencies: { state: 'known', value: [] } }),
    contract({ nonGoals: { state: 'known', value: [] } }),
    contract({ constraints: { state: 'known', value: [] } }),
    contract({ workItem: { ...workItem, id: '999' } }),
  ]
  const fingerprint = fingerprintWorkItemContract(baseline)
  for (const variant of variants) assert.notEqual(fingerprintWorkItemContract(variant), fingerprint)
})
