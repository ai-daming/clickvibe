import assert from 'node:assert/strict'
import test from 'node:test'
import { formatConfirmationPreview, parseCommand } from '../src/workflow/command.ts'
import { formatWriteOutcome } from '../src/workflow/handlers.ts'

test('restore-base command uses the explicit one-use recovery action', () => {
  const parsed = parseCommand('恢复基线 #60 o/r')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.command.action, 'restore-base')

  const preview = formatConfirmationPreview(
    'restore-base',
    null,
    { url: 'https://github.com/o/r/issues/60', baseline: 'origin/release/deleted', baselineRef: 'abc1234' },
    'digest-value',
    1,
  )
  assert.match(preview, /恢复远端基线/)
  assert.match(preview, /origin\/release\/deleted/)
  assert.match(preview, /abc1234/)

  const outcome = formatWriteOutcome('restore-base', {
    status: 200,
    body: { ok: true, baseBranch: 'release/deleted', baseHash: 'abc1234' },
  })
  assert.match(outcome.body.text, /已恢复远端基线 origin\/release\/deleted @ abc1234/)
})
