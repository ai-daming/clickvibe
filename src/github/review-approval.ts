/**
 * Typed review approval (issue #131 slice B, c3): the best-effort native
 * approval becomes a write confirmation transaction. The attempt marker is
 * persisted by the caller before dispatch, and the reviews readback
 * predicate confirms the APPROVED entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { githubWrite } from './writes.ts'

export interface ReviewApprovalInput {
  repoKey: string
  prNumber: string | number | null
  passed: boolean
}

export type ReviewApprovalResult = 'approved' | 'skipped' | 'failed' | 'unknown'

const REVIEW_APPROVAL_BODY = '**身份：Review Agent**\n\nLGTM'

/** Submit a native GitHub approval only for a passing PR review.
 *
 * GitHub can reject this write (notably when the authenticated user authored
 * the PR) — a provable 4xx rejection is 'failed'. An approval the readback
 * could not settle is 'unknown'; both remain non-blocking for the review
 * verdict exactly as before (best-effort).
 */
export async function approvePassedReview(
  ctx: Context,
  input: ReviewApprovalInput,
  persistMarker: () => Promise<void>,
): Promise<ReviewApprovalResult> {
  if (!input.passed || !input.prNumber) return 'skipped'
  const outcome = await githubWrite(ctx, {
    operation: 'pr-review-approve',
    input: { repoKey: input.repoKey, prNumber: Number(input.prNumber), body: REVIEW_APPROVAL_BODY },
    persistMarker,
  })
  if (outcome.outcome === 'confirmed') return 'approved'
  if (outcome.outcome === 'failed') return 'failed'
  return 'unknown'
}
