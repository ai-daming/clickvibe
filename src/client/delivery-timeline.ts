import type { WorkflowEvent } from './domain.ts'

export type DeliveryTimelineDetail =
  | { kind: 'review'; issues: string[] }
  | {
      kind: 'development'
      commits: { hash: string; subject: string }[]
      diffstat: { path: string; insertions: number | null; deletions: number | null }[]
      taskId?: string
    }
  | { kind: 'generic' }

export interface DeliveryTimelineItem {
  event: WorkflowEvent
  kindLabel: string
  summary: string
  detail: DeliveryTimelineDetail
}

const KIND_LABELS: Record<WorkflowEvent['kind'], string> = {
  dev: '开发',
  rework: '返工',
  review: 'Review',
  resume: '恢复',
  note: '备注',
  'merge-override': '人工放行',
  'auto-run': '自动推进',
}

function agentLabel(agent: WorkflowEvent['agent']): string | null {
  if (agent === 'codex') return 'Codex'
  if (agent === 'claude') return 'Claude'
  return null
}

export function deriveDeliveryTimelineItem(event: WorkflowEvent): DeliveryTimelineItem {
  const parts: string[] = []
  if (event.round !== undefined) parts.push(`第 ${event.round} 轮`)
  const agent = agentLabel(event.agent)
  if (agent) parts.push(agent)
  if (event.stats && (event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume')) {
    parts.push(`${event.stats.filesChanged} 文件`, `+${event.stats.insertions}/-${event.stats.deletions}`)
  }
  if (event.kind === 'review' && event.verdict) {
    parts.push(`${event.verdict.issues.length} 条意见`)
  } else if (
    (event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume') &&
    event.fixed !== undefined
  ) {
    parts.push(`处理 ${event.fixed} 条意见`)
  } else if (event.kind === 'merge-override') {
    parts.push(
      `跳过 ${(event.skippedLabels ?? event.skipped ?? []).join('、') || '未知门禁'}`,
      `操作者 @${event.operator ?? '?'}`,
    )
  }

  let detail: DeliveryTimelineDetail = { kind: 'generic' }
  if (event.kind === 'review') {
    detail = { kind: 'review', issues: event.verdict?.issues ?? [] }
  } else if (event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume') {
    detail = {
      kind: 'development',
      commits: event.stats?.commits ?? [],
      diffstat: event.stats?.diffstat ?? [],
      ...(event.taskId ? { taskId: event.taskId } : {}),
    }
  }
  return { event, kindLabel: KIND_LABELS[event.kind], summary: parts.join(' · '), detail }
}
