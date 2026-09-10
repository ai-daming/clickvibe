/**
 * A state poll contains persisted workflows, whereas repo/issues also derives
 * observations for never-started issues. Absence is not archival evidence.
 * Keep list observations; disable vanished cleanup actions so issue #89's
 * stale retry button cannot survive, without inventing a terminal state.
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

/** Merge present observations; missing cleanup waits for authoritative refresh. */
export function applyWorkflowSnapshot<TIssue extends SnapshotIssueLike<unknown>>(
  previous: TIssue[],
  incoming: SnapshotWorkflowLike[],
  pruneMissing = false,
): TIssue[] {
  const byUrl = new Map(incoming.map((item) => [item.url, item]))
  return previous.map((item) => {
    const current = byUrl.get(String(item.url ?? ''))
    if (current) return { ...item, workflow: current } as TIssue
    if (!pruneMissing || !item.workflow) return item
    const workflow = item.workflow as SnapshotWorkflowLike & Record<string, unknown>
    if (workflow.derived?.nextAction?.kind !== 'cleanup') return item
    return {
      ...item,
      workflow: {
        ...workflow,
        derived: {
          ...workflow.derived,
          nextAction: {
            kind: 'none',
            label: '状态待刷新',
            hint: '本轮未返回该工作流，无法确认清理结果；请刷新项目列表',
          },
        },
      },
    } as TIssue
  })
}
