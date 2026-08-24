import { saveCurrentTaskWorkflow } from '../infra/task-ownership.ts'
import { applyDevRunOutcome, type IssueWorkflow, type SessionAgent } from '../infra/state.ts'

/** Persist the actionable completion state before starting slower delivery enrichment. */
export async function finalizeDevRun(
  workflow: IssueWorkflow,
  taskId: string,
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out',
  exitCode: number | null,
  sessionId: string | null,
  agent: SessionAgent,
  deliver: () => Promise<void>,
): Promise<boolean> {
  const completed = applyDevRunOutcome(workflow, status, exitCode, sessionId, agent)
  if (!(await saveCurrentTaskWorkflow(workflow, 'dev', taskId))) return false
  if (completed) await deliver()
  return completed
}
