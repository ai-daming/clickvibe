import { type IssueWorkflow, loadWorkflow, saveWorkflowStrict } from './state.ts'
import { withWorkflowLock } from './workflow-lock.ts'

/** Lock, reload, mutate, and strictly persist one workflow without stale-object overwrites. */
export async function mutateWorkflowStrict(
  key: string,
  mutate: (workflow: IssueWorkflow) => void | Promise<void>,
): Promise<IssueWorkflow> {
  return await withWorkflowLock(key, async () => {
    const current = await loadWorkflow(key)
    if (!current) throw new Error('workflow 已不存在')
    await mutate(current)
    await saveWorkflowStrict(current)
    return current
  })
}
