import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowStatusLabel as clientStatusLabel } from '../src/client/runtime.ts'
import {
  deriveNextAction,
  deriveWorkflowStatus,
  workflowStatusLabel as hostStatusLabel,
  type WorkflowFacts,
} from '../src/workflow/state-view.ts'

function interrupted(stage: 'developing' | 'reviewing'): WorkflowFacts {
  return {
    issueOpen: true,
    prMerged: false,
    prNumber: '111',
    prState: 'OPEN',
    prStatusKnown: true,
    stage,
    devInterrupted: stage === 'developing',
    taskRunning: false,
    head: '82e55b2',
    reviewedHash: null,
    reviewPassed: null,
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    hasNewCommits: false,
    needsSync: false,
    hasCommits: true,
  }
}

test('a lost development task is explicit and resumes through its agent session', () => {
  const facts = interrupted('developing')
  assert.equal(deriveWorkflowStatus(facts), 'interrupted')
  assert.deepEqual(deriveNextAction(facts), {
    kind: 'resume',
    label: '恢复开发',
    hint: '确认旧宿主任务已停止后,续上次 agent 会话恢复开发',
  })
})

test('a lost review task never falls back to ordinary review-ready status', () => {
  const facts = interrupted('reviewing')
  assert.equal(deriveWorkflowStatus(facts), 'interrupted')
  assert.deepEqual(deriveNextAction(facts), {
    kind: 'review',
    label: '重新 Review',
    hint: '确认旧宿主任务已停止后,重新审查当前代码',
  })
})

test('host and client expose the same interrupted status label', () => {
  assert.equal(hostStatusLabel('interrupted', null, false), '任务已中断')
  assert.equal(clientStatusLabel('interrupted', null, false), '任务已中断')
})
