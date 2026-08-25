import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewVerdictView, type ReviewVerdictInput } from '../src/client/runtime.ts'

function derived(overrides: Partial<ReviewVerdictInput['derived']> = {}): ReviewVerdictInput['derived'] {
  return {
    verdictCurrent: true,
    reviewedHash: '31b32dc',
    head: '31b32dc',
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    ...overrides,
  }
}

test('merged workflow no longer offers a revivable verdict or merge hint', () => {
  const view = reviewVerdictView({ reviewResult: { passed: true, issues: [] }, derived: derived(), merged: true })
  assert.equal(view.headline, '✅ 已合并')
  assert.equal(view.showNotes, false)
  assert.deepEqual(view.notes, [])
})

test('a passed verdict keeps its notes visible instead of hiding them', () => {
  const notes = ['[无法验证] 窄面板可读性为 [人工] 验收项(非缺陷)']
  const view = reviewVerdictView({ reviewResult: { passed: true, issues: notes }, derived: derived(), merged: false })
  assert.equal(view.headline, '✅ Review 通过(针对提交 31b32dc)')
  assert.equal(view.showNotes, true)
  assert.deepEqual(view.notes, notes)
})

test('a passed verdict with no notes shows the plain pass headline', () => {
  const view = reviewVerdictView({ reviewResult: { passed: true, issues: [] }, derived: derived(), merged: false })
  assert.equal(view.headline, '✅ Review 通过(针对提交 31b32dc)')
  assert.equal(view.showNotes, false)
})

test('a failed verdict lists its blocking issues', () => {
  const view = reviewVerdictView({
    reviewResult: { passed: false, issues: ['竞态', '缺测试'] },
    derived: derived(),
    merged: false,
  })
  assert.equal(view.headline, '❌ Review 发现 2 个问题(针对提交 31b32dc)')
  assert.equal(view.showNotes, true)
  assert.deepEqual(view.notes, ['竞态', '缺测试'])
})

test('stale verdicts explain expiry instead of impersonating the pass/fail state', () => {
  const changed = reviewVerdictView({
    reviewResult: { passed: true, issues: [] },
    derived: derived({ verdictCurrent: false, issueContractStatus: 'changed' }),
    merged: false,
  })
  assert.match(changed.headline, /⏳ 验收已变更/)

  const staleHead = reviewVerdictView({
    reviewResult: { passed: true, issues: [] },
    derived: derived({ verdictCurrent: false, issueContractStatus: 'current', head: 'new123' }),
    merged: false,
  })
  assert.match(staleHead.headline, /结论针对旧提交/)

  const noSnapshot = reviewVerdictView({
    reviewResult: { passed: true, issues: [] },
    derived: derived({
      verdictCurrent: false,
      issueContractStatus: 'unknown',
      issueContractUnknownReason: 'missing-review-snapshot',
    }),
    merged: false,
  })
  assert.match(noSnapshot.headline, /缺少验收契约快照/)

  const unavailable = reviewVerdictView({
    reviewResult: { passed: true, issues: [] },
    derived: derived({
      verdictCurrent: false,
      issueContractStatus: 'unknown',
      issueContractUnknownReason: 'current-contract-unavailable',
    }),
    merged: false,
  })
  assert.match(unavailable.headline, /暂时无法读取当前验收契约/)
})

test('no verdict means no verdict banner at all', () => {
  const view = reviewVerdictView({ reviewResult: null, derived: derived(), merged: false })
  assert.equal(view.headline, '')
  assert.equal(view.showNotes, false)
})
