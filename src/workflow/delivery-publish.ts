import type { Context } from '@deepseek-ai/cordis'
import { type LiveTask, parseUrl } from '../infra/runtime.ts'
import { appendLog, type IssueWorkflow, type WorkflowEvent } from '../infra/state.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'
import { githubWrite, githubWriteOutcomeError } from '../github/writes.ts'

/** Publish a delivery node only while its originating task still owns workflow writes. */
export async function publishDeliveryComment(
  ctx: Context,
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  body: string,
  live: LiveTask,
): Promise<boolean> {
  const target = workflow.prNumber ? 'pr' : 'issue'
  // Slice B: the comment is a typed non-repeatable write. Its durable attempt
  // marker is the publication record on the workflow event — persisted as
  // 'pending' BEFORE dispatch via the task-owned workflow mutation, so a crash
  // between marker and dispatch recovers by exact-body readback instead of
  // double-posting. The transaction owns invalidation.
  const number = workflow.prNumber ?? parseUrl(workflow.url)?.number
  const persistPendingMarker = async () => {
    let stored = false
    const saved = await mutateLiveTaskWorkflow(live, workflow, (latest) => {
      const storedEvent = latest.events.find(
        (candidate) => candidate.kind === event.kind && candidate.taskId === event.taskId && candidate.at === event.at,
      )
      if (storedEvent) {
        storedEvent.publication = { target, status: 'pending' }
        stored = true
      }
    })
    // A marker that did not durably land proves nothing (review F3): a task
    // that lost workflow ownership — or an event the workflow no longer
    // carries — must fail the transaction BEFORE any GitHub dispatch.
    if (saved.status !== 'committed') {
      throw new Error(`attempt marker 未落盘(${saved.status}),评论零派发`)
    }
    if (!stored) {
      throw new Error('目标事件不在 workflow 中,attempt marker 未落盘,评论零派发')
    }
    event.publication = { target, status: 'pending' }
  }
  const outcome = number
    ? await githubWrite(ctx, {
        operation: 'issue-comment-create',
        input: { repoKey: workflow.repoKey, number: Number(number), body },
        persistMarker: persistPendingMarker,
      })
    : { outcome: 'failed' as const, error: new Error('无法解析目标编号,评论未发布') }
  if (outcome.outcome === 'confirmed') {
    // The dispatched response carries the comment URL; keep it in the
    // publication like the legacy output parsing did, so the panel keeps its
    // ↗ link and the review commentUrl / meta-edit id chain keeps resolving.
    // A lost response settled by readback posts without a link, as before.
    const url = (outcome.value as { html_url?: string } | undefined)?.html_url
    event.publication = { target, status: 'posted', ...(url ? { url } : {}) }
    await appendLog(
      workflow.key,
      event.kind === 'review' ? 'review' : 'dev',
      `[clickvibe] 已发布 GitHub ${target === 'pr' ? 'PR' : 'Issue'} 评论`,
    )
  } else {
    const message = githubWriteOutcomeError(outcome).slice(0, 500)
    // An unprovable write is 'unknown', never folded into 'failed' — the
    // comment may exist upstream and recovery settles it by readback (review F4).
    if (outcome.outcome === 'unknown') {
      event.publication = { target, status: 'unknown', error: message }
      await appendLog(
        workflow.key,
        event.kind === 'review' ? 'review' : 'dev',
        `[clickvibe] GitHub 评论结果未确认: ${message}`,
      )
    } else {
      event.publication = { target, status: 'failed', error: message }
      await appendLog(
        workflow.key,
        event.kind === 'review' ? 'review' : 'dev',
        `[clickvibe] GitHub 评论发布失败: ${message}`,
      )
    }
  }
  const publication = event.publication
  const saved = await mutateLiveTaskWorkflow(live, workflow, (latest) => {
    const storedEvent = latest.events.find(
      (candidate) => candidate.kind === event.kind && candidate.taskId === event.taskId && candidate.at === event.at,
    )
    if (storedEvent) storedEvent.publication = publication
  })
  return saved.status === 'committed'
}
