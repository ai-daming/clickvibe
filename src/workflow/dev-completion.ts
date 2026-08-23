import { applyDevRunOutcome, type IssueWorkflow, type SessionAgent, saveWorkflow } from '../infra/state.ts'

/** Persist the actionable completion state before starting slower delivery enrichment. */
export async function finalizeDevRun(
  workflow: IssueWorkflow,
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out',
  exitCode: number | null,
  sessionId: string | null,
  agent: SessionAgent,
  deliver: () => Promise<void>,
): Promise<boolean> {
  const completed = applyDevRunOutcome(workflow, status, exitCode, sessionId, agent)
  await saveWorkflow(workflow)
  if (completed) await deliver()
  return completed
}
