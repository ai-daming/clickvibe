import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveLogEvent } from '../src/client/runtime.ts'
import {
  COLLAPSED_LOG_CHARACTER_THRESHOLD,
  COLLAPSED_LOG_LINE_THRESHOLD,
  buildLogBlocks,
  collapseLogBlock,
  toggleExpandedLogBlock,
} from '../src/client/log-blocks.ts'

const event = (kind: LiveLogEvent['kind'], text: string, source: LiveLogEvent['source'] = 'agent'): LiveLogEvent => ({
  source,
  kind,
  text,
})

test('consecutive command output becomes one block while other kinds stay independent', () => {
  const events = [
    event('command', '$ first'),
    event('command_output', 'one\ntwo\n'),
    event('command_output', 'three'),
    event('message', 'done'),
    event('command_output', 'last'),
  ]

  const blocks = buildLogBlocks(events)

  assert.deepEqual(
    blocks.map(({ id, kind, text, eventCount }) => ({ id, kind, text, eventCount })),
    [
      { id: 'log-0-command', kind: 'command', text: '$ first', eventCount: 1 },
      { id: 'log-1-command_output', kind: 'command_output', text: 'one\ntwo\nthree', eventCount: 2 },
      { id: 'log-3-message', kind: 'message', text: 'done', eventCount: 1 },
      { id: 'log-4-command_output', kind: 'command_output', text: 'last', eventCount: 1 },
    ],
  )
  assert.equal(events[1].text, 'one\ntwo\n')
  assert.equal(events[2].text, 'three')
})

test('usage stays out of body blocks and does not split adjacent command output', () => {
  const blocks = buildLogBlocks([
    event('command_output', 'one'),
    { source: 'agent', kind: 'usage', text: 'not body', usage: { totalTokens: 4 } },
    event('command_output', 'two'),
  ])

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, 'one\ntwo')
  assert.equal(blocks[0].eventCount, 2)
})

test('block ids stay stable when the live event list appends', () => {
  const initial = [event('message', 'starting'), event('command_output', 'one')]
  const before = buildLogBlocks(initial)
  const after = buildLogBlocks([...initial, event('command_output', 'two'), event('stage', 'finished')])

  assert.equal(after[0].id, before[0].id)
  assert.equal(after[1].id, before[1].id)
  assert.equal(after[1].text, 'one\ntwo')
})

test('long blocks collapse to complete leading lines and report total logical lines', () => {
  const text = Array.from({ length: COLLAPSED_LOG_LINE_THRESHOLD + 1 }, (_, index) => `line ${index + 1}`).join('\n')
  const collapsed = collapseLogBlock(text)

  assert.equal(collapsed.collapsible, true)
  assert.equal(collapsed.lineCount, COLLAPSED_LOG_LINE_THRESHOLD + 1)
  assert.equal(collapsed.text, Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n'))
  assert.equal(collapsed.text.endsWith('\n'), false)
})

test('character threshold collapses at a line boundary without changing the full text', () => {
  const first = 'a'.repeat(500)
  const second = 'b'.repeat(500)
  const fullText = `${first}\n${second}\n${'c'.repeat(COLLAPSED_LOG_CHARACTER_THRESHOLD)}`
  const collapsed = collapseLogBlock(fullText)

  assert.equal(collapsed.collapsible, true)
  assert.equal(collapsed.text, first)
  assert.equal(fullText.includes(collapsed.text), true)
  assert.equal(collapsed.fullText, fullText)
})

test('short text and trailing newlines preserve their display and logical line count', () => {
  assert.deepEqual(collapseLogBlock('short\n'), {
    collapsible: false,
    text: 'short\n',
    fullText: 'short\n',
    lineCount: 1,
  })
  assert.equal(collapseLogBlock('').lineCount, 0)
})

test('expanded block state toggles open and closed without mutating the previous set', () => {
  const initial = new Set<string>()
  const expanded = toggleExpandedLogBlock(initial, 'task:log-1-command_output')
  const collapsed = toggleExpandedLogBlock(expanded, 'task:log-1-command_output')

  assert.equal(initial.size, 0)
  assert.deepEqual([...expanded], ['task:log-1-command_output'])
  assert.equal(collapsed.size, 0)
})
