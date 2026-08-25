import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeLiveLogLine as decodeClientLine,
  deliveryPublicationLabel as clientPublicationLabel,
  formatElapsed as clientFormatElapsed,
  githubCompareUrl as clientCompareUrl,
  latestTokenUsage as clientLatestTokenUsage,
  selectHistoryTask as selectClientHistoryTask,
  taskStartedAt as clientTaskStartedAt,
  workflowStatusLabel as clientStatusLabel,
} from '../src/client/runtime.ts'
import {
  decodeLiveLogLine as decodeHostLine,
  encodeLiveLogEvent,
  formatElapsed as hostFormatElapsed,
  latestTokenUsage as hostLatestTokenUsage,
  taskStartedAt as hostTaskStartedAt,
} from '../src/infra/live-output.ts'
import { selectHistoryTask as selectHostHistoryTask } from '../src/infra/task-history.ts'
import { deliveryPublicationLabel as hostPublicationLabel } from '../src/workflow/delivery-publication.ts'
import {
  githubCompareUrl as hostCompareUrl,
  workflowStatusLabel as hostStatusLabel,
} from '../src/workflow/state-view.ts'

test('host and client preserve the same live-log wire contract', () => {
  const events = [
    { source: 'agent', agent: 'codex', kind: 'message', text: 'done' },
    { source: 'system', kind: 'usage', text: 'tokens', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  ] as const
  for (const event of events) {
    const encoded = encodeLiveLogEvent(event)
    assert.deepEqual(decodeClientLine(encoded), decodeHostLine(encoded))
  }
  for (const line of ['legacy output', '[clickvibe] reconnecting', '[clickvibe:event]%broken']) {
    assert.deepEqual(decodeClientLine(line), decodeHostLine(line))
  }
})

test('host and client preserve the same task-history selection', () => {
  const workflows = [
    { stage: 'developing', devTaskId: 'dev-200-a', reviewTaskId: 'review-100-a', hasReviewResult: true },
    { stage: 'reviewing', devTaskId: 'dev-100-a', reviewTaskId: 'review-200-a', hasReviewResult: false },
    { stage: 'review-ready', devTaskId: 'dev-100-a', reviewTaskId: 'review-200-a', hasReviewResult: false },
    { stage: 'passed', devTaskId: 'dev-200-a', reviewTaskId: 'review-100-a', hasReviewResult: true },
  ] as const
  for (const workflow of workflows) {
    assert.deepEqual(selectClientHistoryTask(workflow), selectHostHistoryTask(workflow))
  }
})

test('host and client preserve the same pure presentation helpers', () => {
  for (const args of [
    ['owner/repo', 'feature/x', 'origin/release', 'main', true],
    ['owner/repo', 'feature/x', 'HEAD', 'trunk', true],
    ['owner/repo', 'feature/x', 'origin/release @ abc123', 'main', false],
  ] as const) {
    assert.equal(clientCompareUrl(...args), hostCompareUrl(...args))
  }
  for (const args of [
    ['idle', null, undefined, undefined, undefined],
    ['review-ready', true, false, 'changed', null],
    ['review-ready', false, true, 'current', null],
    ['review-ready', true, false, 'unknown', 'current-contract-unavailable'],
    ['passed', true, true, 'current', null],
  ] as const) {
    assert.equal(clientStatusLabel(...args), hostStatusLabel(...args))
  }
  for (const publication of [
    undefined,
    { target: 'pr', status: 'posted', url: 'https://example.test' },
    { target: 'issue', status: 'posted' },
    { target: 'issue', status: 'failed', error: 'offline' },
  ] as const) {
    assert.equal(clientPublicationLabel(publication), hostPublicationLabel(publication))
  }
})

test('host and client preserve the same terminal timing and usage helpers', () => {
  for (const elapsed of [-1, 0, 59_000, 3_661_000]) {
    assert.equal(clientFormatElapsed(elapsed), hostFormatElapsed(elapsed))
  }
  for (const taskId of [null, 'invalid', 'dev-1700000000000-1']) {
    assert.equal(clientTaskStartedAt(taskId), hostTaskStartedAt(taskId))
  }
  const events = [
    { source: 'agent', kind: 'text', text: 'before' },
    { source: 'agent', kind: 'usage', text: 'usage', usage: { totalTokens: 7 } },
  ] as const
  assert.deepEqual(clientLatestTokenUsage([...events]), hostLatestTokenUsage([...events]))
})
