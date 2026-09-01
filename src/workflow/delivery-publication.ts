export type { DeliveryPublication } from '../infra/contracts.ts'

import type { DeliveryPublication } from '../infra/contracts.ts'

// client/runtime.ts mirrors this presentation label without importing host
// code; runtime-contract.test.ts verifies both implementations together.

const GITHUB_COMMENT_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/

/** Select the first complete GitHub comment URL and ignore surrounding CLI output. */
export function extractGithubCommentUrl(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => GITHUB_COMMENT_URL.test(line))
}

export function extractGithubCommentId(url: string): string | undefined {
  if (!GITHUB_COMMENT_URL.test(url)) return undefined
  return url.match(/#issuecomment-(\d+)$/)?.[1]
}

/** Keep publication wording in one tested place for the delivery timeline UI. */
export function deliveryPublicationLabel(publication: DeliveryPublication | undefined): string {
  if (!publication) return '本地事件'
  if (publication.status === 'pending') return 'GitHub 评论发布中(未确认)'
  if (publication.status === 'failed') return 'GitHub 评论发布失败'
  return `GitHub ${publication.target === 'pr' ? 'PR' : 'Issue'} 评论${publication.url ? ' ↗' : '已发布'}`
}
