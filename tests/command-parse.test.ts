import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommand } from '../src/workflow/command.ts'

test('parseCommand understands the canonical Chinese phrasing and strict grammar', () => {
  const canonical = parseCommand('把 #8 下单开发')
  assert.ok(canonical.ok)
  assert.equal(canonical.command.action, 'develop')
  assert.equal(canonical.command.number, '8')
  assert.equal(canonical.command.agent, null)

  const glued = parseCommand('把#8下单开发')
  assert.ok(glued.ok)
  assert.equal(glued.command.action, 'develop')
  assert.equal(glued.command.number, '8')

  const full = parseCommand('develop 8 ai-daming/clickvibe agent=claude')
  assert.ok(full.ok)
  assert.deepEqual(
    [full.command.action, full.command.number, full.command.repoKey, full.command.agent],
    ['develop', '8', 'ai-daming/clickvibe', 'claude'],
  )

  const dryrun = parseCommand('安全演练 #8')
  assert.ok(dryrun.ok)
  assert.equal(dryrun.command.action, 'develop')
  assert.equal(dryrun.command.agent, 'dryrun')

  const rework = parseCommand('rework #8 context=先修 A 再补测试')
  assert.ok(rework.ok)
  assert.equal(rework.command.action, 'rework')
  assert.equal(rework.command.context, '先修 A 再补测试')

  const urlStatus = parseCommand('status https://github.com/o/r/issues/23')
  assert.ok(urlStatus.ok)
  assert.equal(urlStatus.command.action, 'status')
  assert.equal(urlStatus.command.url, 'https://github.com/o/r/issues/23')

  const prReview = parseCommand('用 claude review https://github.com/o/r/pull/41')
  assert.ok(prReview.ok)
  assert.equal(prReview.command.action, 'review')
  assert.equal(prReview.command.agent, 'claude')

  for (const bad of ['', 'foo bar', 'develop', 'develop #8 agent=gpt', 'develop #8 context=']) {
    const rejected = parseCommand(bad)
    assert.equal(rejected.ok, false, `"${bad}" must be rejected`)
  }
})
