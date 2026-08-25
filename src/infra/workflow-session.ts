import type { IssueWorkflow, SessionAgent } from './state.ts'

type DevRunOutcomeState = Pick<
  IssueWorkflow,
  | 'stage'
  | 'devInterrupted'
  | 'devSessionId'
  | 'devSessionAgent'
  | 'reviewSessionId'
  | 'reviewSessionAgent'
  | 'reviewResult'
>
type SessionState = Pick<IssueWorkflow, 'devSessionId' | 'devSessionAgent' | 'reviewSessionId' | 'reviewSessionAgent'>

/** Apply the durable state shared by initial-development and resumed runs. */
export function applyDevRunOutcome(
  workflow: DevRunOutcomeState,
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out',
  exitCode: number | null,
  sessionId: string | null,
  agent: SessionAgent,
): boolean {
  const completed = status === 'done' && exitCode === 0
  workflow.stage = completed ? 'review-ready' : 'developing'
  workflow.devInterrupted = !completed
  recordSessionId(workflow, 'dev', sessionId, agent)
  if (completed) workflow.reviewResult = null
  return completed
}

/** Persist a session id together with the agent family that emitted it. */
export function recordSessionId(
  workflow: SessionState,
  kind: 'dev' | 'review',
  sessionId: string | null,
  agent: SessionAgent,
): void {
  if (!sessionId) return
  if (kind === 'dev') {
    workflow.devSessionId = sessionId
    workflow.devSessionAgent = agent
  } else {
    workflow.reviewSessionId = sessionId
    workflow.reviewSessionAgent = agent
  }
}

/** Validate ownership before resume; legacy/unknown/mismatched owners are stale. */
export function resolveSessionForAgent(
  workflow: SessionState,
  kind: 'dev' | 'review',
  agent: SessionAgent,
): { sessionId: string | null; invalid: boolean } {
  const idField = kind === 'dev' ? 'devSessionId' : 'reviewSessionId'
  const agentField = kind === 'dev' ? 'devSessionAgent' : 'reviewSessionAgent'
  const sessionId = workflow[idField]
  if (!sessionId) {
    workflow[agentField] = null
    return { sessionId: null, invalid: false }
  }
  if (workflow[agentField] !== agent) {
    workflow[idField] = null
    workflow[agentField] = null
    return { sessionId: null, invalid: true }
  }
  return { sessionId, invalid: false }
}

/** Clear only the rejected id, never a newer session captured concurrently. */
export function clearStaleSessionId(
  workflow: SessionState,
  kind: 'dev' | 'review',
  rejectedSessionId: string,
): boolean {
  const field = kind === 'dev' ? 'devSessionId' : 'reviewSessionId'
  const agentField = kind === 'dev' ? 'devSessionAgent' : 'reviewSessionAgent'
  if (workflow[field] !== rejectedSessionId) return false
  workflow[field] = null
  workflow[agentField] = null
  return true
}
