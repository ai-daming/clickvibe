import { applyDevRunOutcome, type IssueWorkflow, type SessionAgent, mutateWorkflowForTask } from '../infra/state.ts'

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
  let completed = false
  const result = await mutateWorkflowForTask(workflow, { kind: 'dev', taskId }, (current) => {
    completed = applyDevRunOutcome(current, status, exitCode, sessionId, agent)
  })
  if (result.status === 'ownership-lost') return false
  if (completed) await deliver()
  return completed
}
