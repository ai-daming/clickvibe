import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeLiveLogLine,
  encodeLiveLogEvent,
  formatElapsed,
  latestTokenUsage,
  taskStartedAt,
  tokenUsage,
} from '../src/infra/live-output.ts'

test('structured live records round-trip while old log lines remain readable', () => {
  const event = { source: 'agent', agent: 'codex', kind: 'command', text: '$ pnpm test' } as const
  assert.deepEqual(decodeLiveLogLine(encodeLiveLogEvent(event)), event)
  assert.deepEqual(decodeLiveLogLine('[clickvibe] reconnecting'), {
    source: 'system',
    kind: 'system',
    text: '[clickvibe] reconnecting',
  })
  assert.equal(decodeLiveLogLine('legacy agent line').text, 'legacy agent line')
  const longEvent = {
    source: 'agent',
    kind: 'command_output',
    text: `/Users/example/project\n  ${'x'.repeat(7000)}\n/tmp/clickvibe`,
  } as const
  assert.deepEqual(decodeLiveLogLine(encodeLiveLogEvent(longEvent)), longEvent)
})

test('token usage accepts both agent field conventions and stays optional', () => {
  assert.deepEqual(tokenUsage({ input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 5 }), {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 5,
    totalTokens: 15,
  })
  assert.equal(tokenUsage({ cost_usd: 1 }), undefined)
  assert.deepEqual(
    latestTokenUsage([
      { source: 'agent', kind: 'usage', text: '', usage: { totalTokens: 5 } },
      { source: 'agent', kind: 'usage', text: '', usage: { totalTokens: 8 } },
    ]),
    { totalTokens: 8 },
  )
})

test('elapsed duration always uses HH:MM:SS and task ids expose start time', () => {
  assert.equal(formatElapsed(204_000), '00:03:24')
  assert.equal(formatElapsed(3_724_000), '01:02:04')
  assert.equal(formatElapsed(-1), '00:00:00')
  assert.equal(taskStartedAt('dev-1720000000000-random'), 1720000000000)
  assert.equal(taskStartedAt('legacy'), null)
})
