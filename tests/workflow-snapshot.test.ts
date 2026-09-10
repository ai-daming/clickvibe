import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWorkflowSnapshot } from '../src/client/workflow-snapshot.ts'

interface IssueLike {
  url: string
  workflow?: { url: string; derived?: { nextAction: { kind: string; label: string; hint: string } } } | null
}

const issue = (url: string, kind = 'cleanup'): IssueLike => ({
  url,
  workflow: { url, derived: { nextAction: { kind, label: '重试清理', hint: '清理未完成' } } },
})

/** Missing persisted rows must suppress stale cleanup, not invent an archive receipt. */
test('missing cleanup disables the stale action without asserting delivery', async () => {
  const before: IssueLike[] = [
    issue('https://github.com/o/r/issues/89'),
    issue('https://github.com/o/r/issues/90', 'none'),
  ]
  const next = applyWorkflowSnapshot(before, [], true)
  const archived = next.find((item) => item.url.endsWith('89'))
  assert.equal(archived?.workflow?.derived?.nextAction.kind, 'none', '缺失时不得保留旧清理动作')
  assert.equal(archived?.workflow?.derived?.nextAction.label, '状态待刷新')
  assert.doesNotMatch(archived?.workflow?.derived?.nextAction.hint ?? '', /已归档|交付完成/)
  // 其它动作以及单条更新路径(prune=false)不受影响
  assert.equal(next.find((item) => item.url.endsWith('90'))?.workflow?.derived?.nextAction.kind, 'none')
  const untouched = applyWorkflowSnapshot(before, [], false)
  assert.equal(untouched.find((item) => item.url.endsWith('89'))?.workflow?.derived?.nextAction.kind, 'cleanup')
})

test('applyWorkflowSnapshot still merges incoming workflow states', async () => {
  const before: IssueLike[] = [issue('https://github.com/o/r/issues/89')]
  const next = applyWorkflowSnapshot(before, [
    {
      url: 'https://github.com/o/r/issues/89',
      derived: { nextAction: { kind: 'review', label: 'Review', hint: '待审查' } },
    },
  ] as never)
  assert.equal(next[0]?.workflow?.derived?.nextAction.kind, 'review')
})

test('a never-started issue keeps its observed development action when no persisted workflow exists', () => {
  const before = [
    {
      url: 'https://github.com/o/r/issues/26',
      workflow: {
        url: 'https://github.com/o/r/issues/26',
        stage: 'idle',
        derived: { status: 'idle', nextAction: { kind: 'develop', label: '开始开发', hint: '准备工作区' } },
      },
    },
  ]
  const unchanged = structuredClone(before)
  const next = applyWorkflowSnapshot(before, [], true)
  assert.deepEqual(next, unchanged)
  assert.deepEqual(before, unchanged)
})

test('missing rows preserve blocked and review observations instead of relabeling all as delivered', () => {
  for (const [kind, label] of [
    ['none', '依赖未完成'],
    ['review', '开始 Review'],
    ['none', '已关闭'],
  ]) {
    const row = issue('https://github.com/o/r/issues/28', kind)
    row.workflow!.derived!.nextAction.label = label
    assert.deepEqual(applyWorkflowSnapshot([row], [], true), [row])
  }
})

test('fresh observations replace a missing cleanup placeholder and remain unchanged on partial snapshots', () => {
  const before = [issue('https://github.com/o/r/issues/89')]
  const missing = applyWorkflowSnapshot(before, [], true)
  assert.equal(missing[0].workflow!.derived!.nextAction.kind, 'none')
  assert.deepEqual(applyWorkflowSnapshot(missing, [], true), missing)
  for (const action of [
    { kind: 'cleanup', label: '重试清理', hint: '仍未完成' },
    { kind: 'none', label: '已交付', hint: 'PR 已合并' },
  ]) {
    const observed = { url: before[0].url, derived: { nextAction: action } }
    assert.deepEqual(applyWorkflowSnapshot(missing, [observed], true)[0].workflow, observed)
  }
  assert.deepEqual(applyWorkflowSnapshot(before, [], false), before)
})
