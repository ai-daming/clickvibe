import { applyDevRunOutcome, type IssueWorkflow, type SessionAgent, saveWorkflowForTask } from '../infra/state.ts'

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
  if (!(await saveWorkflowForTask(workflow, { kind: 'dev', taskId }, workflow.revision ?? 0))) return false
  if (completed) await deliver()
  return completed
}
