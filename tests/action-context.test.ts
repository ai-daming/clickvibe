import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearedContext,
  contextToSubmit,
  toggledContext,
} from '../src/client/action-context.ts'

test('rework prefills the current review issues on first expand', () => {
  const next = toggledContext(
    { open: false, text: '' },
    'rework',
    ['修复竞态', '补充失败测试'],
  )
  assert.deepEqual(next, { open: true, text: '修复竞态\n补充失败测试' })
})

test('rework expand keeps user-edited text instead of overwriting it', () => {
  const next = toggledContext(
    { open: false, text: '用户已编辑的说明' },
    'rework',
    ['修复竞态'],
  )
  assert.deepEqual(next, { open: true, text: '用户已编辑的说明' })
})

test('rework expand without review issues stays empty and other actions never prefill', () => {
  assert.deepEqual(
    toggledContext({ open: false, text: '' }, 'rework', []),
    { open: true, text: '' },
  )
  assert.deepEqual(
    toggledContext({ open: false, text: '' }, 'rework', null),
    { open: true, text: '' },
  )
  // develop / resume / review 不预填,即便存在 review 意见。
  for (const kind of ['develop', 'resume', 'review']) {
    assert.deepEqual(
      toggledContext({ open: false, text: '' }, kind, ['修复竞态']),
      { open: true, text: '' },
    )
  }
})

test('collapsing preserves the text for the next expand', () => {
  const next = toggledContext(
    { open: true, text: '暂存的说明' },
    'rework',
    ['修复竞态'],
  )
  assert.deepEqual(next, { open: false, text: '暂存的说明' })
})

test('a launched action clears and collapses the input so stale text cannot leak', () => {
  assert.deepEqual(clearedContext(), { open: false, text: '' })
})

test('the submitted context is trimmed; blank input means no context is sent', () => {
  assert.equal(contextToSubmit('  优先补齐边界测试\n'), '优先补齐边界测试')
  assert.equal(contextToSubmit('   \n\t'), '')
  assert.equal(contextToSubmit(''), '')
})
