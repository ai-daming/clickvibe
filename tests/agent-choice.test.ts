import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveAgentChoicePolicy } from '../src/client/agent-choice.ts'

const unavailable = { round: 5, develop: false, review: false }
const available = { round: 6, develop: true, review: true }

test('agent choice policy covers initial, locked continuation and unlocked fresh paths', () => {
  assert.deepEqual(deriveAgentChoicePolicy('develop', unavailable, 'codex', null), {
    disabled: false,
    tooltip: '选择 agent',
    freshEntry: null,
    continuationAgent: null,
    preferredAgent: 'codex',
  })
  assert.deepEqual(deriveAgentChoicePolicy('resume', unavailable, 'codex', 'claude'), {
    disabled: true,
    tooltip: '换 agent 需新开会话',
    freshEntry: null,
    continuationAgent: 'codex',
    preferredAgent: 'codex',
  })
  assert.deepEqual(deriveAgentChoicePolicy('rework', available, 'codex', 'claude'), {
    disabled: false,
    tooltip: '选择 agent',
    freshEntry: 'develop',
    continuationAgent: 'codex',
    preferredAgent: 'codex',
  })
  assert.deepEqual(deriveAgentChoicePolicy('review', available, 'codex', 'claude'), {
    disabled: false,
    tooltip: '选择 agent',
    freshEntry: 'review',
    continuationAgent: 'claude',
    preferredAgent: 'claude',
  })
})

test('review continuation stays locked and unrelated actions keep a disabled toggle visible', () => {
  assert.equal(deriveAgentChoicePolicy('review', unavailable, 'codex', 'claude').disabled, true)
  assert.deepEqual(deriveAgentChoicePolicy('merge', available, 'codex', 'claude'), {
    disabled: true,
    tooltip: '当前动作无需选择 agent',
    freshEntry: null,
    continuationAgent: null,
    preferredAgent: 'codex',
  })
})
