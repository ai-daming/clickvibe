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

/**
 * 归档后的 workflow 从服务端状态响应中消失(loadAllWorkflows 排除 archived)。
 * 客户端若只合并不终结,清理前最后一份缓存(带"重试清理"按钮)会被永久冻结
 * (#89 现场,2026-08-25:合并 16:06:43 → 清理完成 16:06:58,面板此后一直显示可点的"重试清理")。
 */
test('applyWorkflowSnapshot terminalizes workflows that vanish from a fresh poll', async () => {
  const before: IssueLike[] = [
    issue('https://github.com/o/r/issues/89'),
    issue('https://github.com/o/r/issues/90', 'none'),
  ]
  const next = applyWorkflowSnapshot(before, [], true)
  const archived = next.find((item) => item.url.endsWith('89'))
  assert.equal(archived?.workflow?.derived?.nextAction.kind, 'none', '归档后不得保留可点动作')
  assert.match(archived?.workflow?.derived?.nextAction.hint ?? '', /归档|交付完成/)
  // 未归档的、以及单条更新路径(prune=false)不受影响
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
