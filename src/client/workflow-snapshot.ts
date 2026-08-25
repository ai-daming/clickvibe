/**
 * Pure workflow-snapshot merge for the project panel.
 *
 * Archived workflows vanish from the server state response (loadAllWorkflows
 * excludes archived). A merge that only updates incoming entries freezes the
 * last cached state forever — including a clickable "重试清理" captured during
 * the merge→cleanup window (#89, 2026-08-25: merged 16:06:43, cleaned
 * 16:06:58, panel kept the zombie button). Vanished + prune → terminal
 * display, never a zombie action.
 */

export interface SnapshotWorkflowLike {
  url: string
  derived?: {
    nextAction?: { kind?: string; label?: string; hint?: string }
  } & Record<string, unknown>
}

export interface SnapshotIssueLike<TWorkflow> {
  url?: unknown
  workflow?: TWorkflow | null
}

/** Apply fresh workflow states; vanished workflows are archived → terminal display. */
export function applyWorkflowSnapshot<TIssue extends SnapshotIssueLike<unknown>>(
  previous: TIssue[],
  incoming: SnapshotWorkflowLike[],
  pruneMissing: boolean,
): TIssue[] {
  const byUrl = new Map(incoming.map((item) => [item.url, item]))
  return previous.map((item) => {
    const current = byUrl.get(String(item.url ?? ''))
    if (current) return { ...item, workflow: current } as TIssue
    if (!pruneMissing || !item.workflow) return item
    const workflow = item.workflow as SnapshotWorkflowLike & Record<string, unknown>
    return {
      ...item,
      workflow: {
        ...workflow,
        derived: {
          ...workflow.derived,
          nextAction: { kind: 'none', label: '已交付', hint: 'PR 已合并,清理完成,已归档' },
        },
      },
    } as TIssue
  })
}
