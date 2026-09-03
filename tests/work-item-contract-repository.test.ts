import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  contractHasKnownCanonicalFields,
  materializeGithubWorkItemContract,
  promptSnapshotFromContract,
} from '../src/workflow/work-item-contract-repository.ts'

const fullBody = `## 目标
Ship it

## 验收标准
- [ ] It works

## 依赖
无

## 非目标
无

## 约束
- No v0.3

## 架构影响与基线
- 架构影响等级：L3
`

function item(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://github.com/ai-daming/clickvibe/issues/136',
    title: 'Contract title',
    body: fullBody,
    state: 'OPEN',
    updatedAt: '2026-09-03T00:00:00Z',
    comments: [],
    ...overrides,
  }
}

test('one provider observation materializes the prompt and canonical snapshot from the same raw bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-repository-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await materializeGithubWorkItemContract({
    root,
    item: item(),
    blockedBy: [],
    capturedAt: '2026-09-03T00:00:01Z',
  })
  assert.equal(result.state, 'known')
  if (result.state !== 'known') return
  assert.equal(contractHasKnownCanonicalFields(result.snapshot), true)
  assert.deepEqual(promptSnapshotFromContract(result), {
    url: 'https://github.com/ai-daming/clickvibe/issues/136',
    title: 'Contract title',
    body: fullBody,
    state: 'OPEN',
    updatedAt: '2026-09-03T00:00:00Z',
    comments: [],
  })

  const metadataOnly = await materializeGithubWorkItemContract({
    root,
    item: item({
      title: 'New title',
      updatedAt: '2026-09-03T00:00:02Z',
      comments: [{ author: { login: 'bot' }, body: 'note' }],
    }),
    blockedBy: [],
    capturedAt: '2026-09-03T00:00:03Z',
  })
  assert.equal(metadataOnly.state, 'known')
  if (metadataOnly.state === 'known') assert.equal(metadataOnly.snapshot.fingerprint, result.snapshot.fingerprint)
})

test('missing canonical sections remain explicit unknown and cannot authorize', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-contract-unknown-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await materializeGithubWorkItemContract({
    root,
    item: item({ body: fullBody.replace(/\n## 约束[\s\S]*?(?=\n## 架构影响)/, '') }),
    blockedBy: [],
    capturedAt: '2026-09-03T00:00:01Z',
  })
  assert.equal(result.state, 'known')
  if (result.state === 'known') assert.equal(contractHasKnownCanonicalFields(result.snapshot), false)
})
