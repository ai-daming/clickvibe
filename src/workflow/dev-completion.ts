import type { LiveTask } from '../infra/runtime.ts'
import { applyDevRunOutcome, type IssueWorkflow, type SessionAgent } from '../infra/state.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'

/** Persist the actionable completion state before starting slower delivery enrichment. */
export async function finalizeDevRun(
  workflow: IssueWorkflow,
  live: LiveTask,
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out',
  exitCode: number | null,
  sessionId: string | null,
  agent: SessionAgent,
  deliver: () => Promise<void>,
): Promise<boolean> {
  let completed = false
  const result = await mutateLiveTaskWorkflow(live, workflow, (current) => {
    completed = applyDevRunOutcome(current, status, exitCode, sessionId, agent)
  })
  if (result.status === 'ownership-lost') return false
  if (completed) await deliver()
  return completed
}
