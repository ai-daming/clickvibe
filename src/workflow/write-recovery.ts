/**
 * Restart recovery for unsettled write markers (issue #131 slice B, review F4).
 *
 * A workflow claimed by a fresh task may still carry pending/unknown delivery
 * publications or approval attempts from a crashed predecessor: the write may
 * or may not have executed upstream. Recovery settles every such marker by
 * readback ONLY (ADR-0010 §9) — zero write dispatch, ever — and persists the
 * resolution through the claiming task's workflow lease. Recovery is
 * best-effort at claim time: a failing readback leaves the marker untouched
 * for the next claim, with the failure on the diagnostics record.
 */
import type { Context } from '@deepseek-ai/cordis'
import { REVIEW_APPROVAL_BODY } from '../github/review-approval.ts'
import { githubWriteOutcomeError, githubWriteRecoverOperation } from '../github/writes.ts'
import type { LiveTask } from '../infra/runtime.ts'
import { parseUrl } from '../infra/runtime.ts'
import type { IssueWorkflow, WorkflowEvent } from '../infra/state.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { buildDevComment, buildReviewComment } from './delivery-comment.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'

interface EventKey {
  kind: WorkflowEvent['kind']
  taskId?: string
  at: string
}

const eventKey = (event: WorkflowEvent): EventKey => ({ kind: event.kind, taskId: event.taskId, at: event.at })

const sameEvent = (candidate: WorkflowEvent, key: EventKey): boolean =>
  candidate.kind === key.kind && candidate.taskId === key.taskId && candidate.at === key.at

/** Rebuild the exact comment body the crashed task dispatched for this event.
 *  The dev body embeds the fixed issue list, which the event stores only as a
 *  count: reconstruct it from the last failed review BEFORE this event and
 *  verify against the count — a mismatch proves nothing and skips recovery. */
function deliveryBody(event: WorkflowEvent, issueNumber: string, workflow: IssueWorkflow): string {
  if (event.kind === 'review') {
    return buildReviewComment({
      commit: event.hash ?? 'unknown',
      issueNumber,
      passed: event.verdict?.passed ?? false,
      issues: event.verdict?.issues ?? [],
      agent: event.agent ?? 'codex',
      round: event.round ?? 1,
      stats: event.stats,
      at: event.at,
    })
  }
  const index = workflow.events.findIndex((candidate) => candidate === event)
  const previousFailedReview =
    index > 0
      ? [...workflow.events.slice(0, index)]
          .reverse()
          .find((candidate) => candidate.kind === 'review' && candidate.verdict?.passed === false)
      : undefined
  const fixedIssues = previousFailedReview?.verdict?.issues ?? []
  if (fixedIssues.length !== (event.fixed ?? 0)) return ''
  return buildDevComment({
    commit: event.hash ?? 'unknown',
    issueNumber,
    fixedIssues,
    agent: event.agent ?? 'codex',
    round: event.round ?? 1,
    stats: event.stats,
    at: event.at,
  })
}

const unsettledPublication = (event: WorkflowEvent) =>
  event.publication?.status === 'pending' || event.publication?.status === 'unknown'
const unsettledApproval = (event: WorkflowEvent) =>
  event.approvalAttempt?.status === 'pending' || event.approvalAttempt?.status === 'unknown'

/** Settle a freshly claimed workflow's pending/unknown write markers by
 *  readback only. Fast path: workflows without unsettled markers touch
 *  nothing. */
export async function recoverUnsettledWrites(ctx: Context, live: LiveTask, workflow: IssueWorkflow): Promise<void> {
  const issueNumber = parseUrl(workflow.url)?.number
  const candidates = workflow.events.filter((event) => unsettledPublication(event) || unsettledApproval(event))
  if (issueNumber === undefined || candidates.length === 0) return
  const resolutions: Array<{ key: EventKey; apply: (event: WorkflowEvent) => void }> = []
  for (const event of candidates) {
    try {
      if (unsettledPublication(event) && event.publication) {
        const target = event.publication.target
        const number = target === 'pr' && workflow.prNumber ? Number(workflow.prNumber) : Number(issueNumber)
        const body = deliveryBody(event, issueNumber, workflow)
        if (body === '') continue
        const recovered = await githubWriteRecoverOperation(ctx, {
          operation: 'issue-comment-create',
          input: { repoKey: workflow.repoKey, number, body },
        })
        if (recovered.outcome === 'confirmed') {
          resolutions.push({
            key: eventKey(event),
            apply: (stored) => (stored.publication = { target, status: 'posted' }),
          })
        } else if (event.publication.status === 'pending') {
          const error = githubWriteOutcomeError(recovered).slice(0, 500)
          resolutions.push({
            key: eventKey(event),
            apply: (stored) => (stored.publication = { target, status: 'unknown', error }),
          })
        }
      }
      if (unsettledApproval(event) && event.approvalAttempt && workflow.prNumber && event.hash) {
        const recovered = await githubWriteRecoverOperation(ctx, {
          operation: 'pr-review-approve',
          input: {
            repoKey: workflow.repoKey,
            prNumber: Number(workflow.prNumber),
            body: REVIEW_APPROVAL_BODY,
            reviewedHead: event.hash,
          },
        })
        if (recovered.outcome === 'confirmed') {
          resolutions.push({
            key: eventKey(event),
            apply: (stored) => (stored.approvalAttempt = { status: 'confirmed' }),
          })
        } else if (event.approvalAttempt.status === 'pending') {
          resolutions.push({
            key: eventKey(event),
            apply: (stored) => (stored.approvalAttempt = { status: 'unknown' }),
          })
        }
      }
    } catch (error) {
      logTaskDiagnostic('write-recovery-error', {
        workflowKey: workflow.key,
        eventAt: event.at,
        eventKind: event.kind,
        error: String(error instanceof Error ? error.message : error),
        note: 'readback 恢复失败,marker 保持原状等待下一次认领',
      })
    }
  }
  if (resolutions.length === 0) return
  const saved = await mutateLiveTaskWorkflow(live, workflow, (latest) => {
    for (const resolution of resolutions) {
      const stored = latest.events.find((candidate) => sameEvent(candidate, resolution.key))
      if (stored) resolution.apply(stored)
    }
  })
  if (saved.status !== 'committed') {
    logTaskDiagnostic('write-recovery-persist-skipped', {
      workflowKey: workflow.key,
      status: saved.status,
      note: '恢复结论未落盘,marker 保持原状等待下一次认领',
    })
  }
}
