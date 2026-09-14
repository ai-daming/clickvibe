import assert from 'node:assert/strict'
import test from 'node:test'
import { readAssessmentOutput } from '../src/agent/assessment-output.ts'
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { id: 'mine', source: { kind: 'user' } } },
  { type: 'step/start', data: { turn: 1 } },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'Implementation Gate: NEEDS_EVIDENCE\nWork: x\nMissing evidence' }] },
    },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
test('assessment result belongs to one completed input, never just idle or a partial last response', () => {
  assert.match(readAssessmentOutput(events, 'mine'), /NEEDS_EVIDENCE/)
  assert.throws(() => readAssessmentOutput(events.slice(0, -1), 'mine'), /完整|完成/)
  assert.throws(() => readAssessmentOutput(events, 'other'), /输入/)
  assert.throws(
    () =>
      readAssessmentOutput(
        [...events, { type: 'user/message', data: { id: 'steering', source: { kind: 'user' } } }],
        'mine',
      ),
    /输入/,
  )
  assert.throws(
    () =>
      readAssessmentOutput(
        [...events.slice(0, -1), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }],
        'mine',
      ),
    /完成/,
  )
})
