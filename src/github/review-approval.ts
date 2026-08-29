import { shellQuote } from '../infra/develop-core.ts'

export interface ReviewApprovalInput {
  repoKey: string
  prNumber: string | number | null
  passed: boolean
}

export type ReviewApprovalResult = 'approved' | 'skipped' | 'failed'

const REVIEW_APPROVAL_BODY = '**身份：Review Agent**\n\nLGTM'

/** Submit a native GitHub approval only for a passing PR review.
 *
 * GitHub can reject this write (notably when the authenticated user authored
 * the PR), so approval is deliberately best-effort and never escapes errors.
 */
export async function approvePassedReview(
  input: ReviewApprovalInput,
  run: (command: string) => Promise<unknown>,
): Promise<ReviewApprovalResult> {
  if (!input.passed || !input.prNumber) return 'skipped'

  const prUrl = `https://github.com/${input.repoKey}/pull/${input.prNumber}`
  try {
    await run(`gh pr review ${shellQuote(prUrl)} --approve --body ${shellQuote(REVIEW_APPROVAL_BODY)}`)
    return 'approved'
  } catch {
    return 'failed'
  }
}
