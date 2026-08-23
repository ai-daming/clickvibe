/** Pure snapshot and confirmation-copy helpers for client-side authorization. */
import type { GhIssue } from './views/issue-view.tsx'

export interface AuthorizationPreview {
  title?: string
  updatedAt?: string
  commentCount?: number
  digest: string
  prNumber?: string
  branch?: string
  mergeFlag?: string
  cleanup?: string[]
}

export function expectedDevelopSnapshot(url: string, issue: GhIssue) {
  return {
    url,
    title: String(issue.title ?? ''),
    body: String(issue.body ?? ''),
    state: String(issue.state ?? '').toUpperCase(),
    updatedAt: String(issue.updatedAt ?? ''),
    comments: (issue.comments ?? []).map((comment) => ({
      author: String(comment.author?.login ?? 'unknown'),
      body: String(comment.body ?? ''),
    })),
  }
}

export function authorizationSummary(input: {
  action: 'develop' | 'review' | 'resume' | 'create-pr' | 'merge'
  agent: 'codex' | 'claude' | null
  url: string
  authorizationDigest: string
  preview: AuthorizationPreview
  freshSession?: boolean
}): string {
  const { action, agent, url, authorizationDigest, preview, freshSession } = input
  if (action === 'develop') {
    return `${agent} 将以高权限开发以下已冻结快照:\n\n${preview.title ?? url}\n更新时间: ${preview.updatedAt || '未知'}\n评论: ${preview.commentCount ?? 0} 条\n快照: ${preview.digest.slice(0, 12)}\n\n确认启动?`
  }
  if (action === 'merge') {
    return `ClickVibe 将执行不可逆的合并与清理:\n\nPR: #${preview.prNumber ?? '?'}\n分支: ${preview.branch ?? '?'}\n策略: ${preview.mergeFlag ?? '--merge'} (merge commit，禁止 squash/rebase)\n清理: ${(preview.cleanup ?? []).join('、')}\n授权: ${authorizationDigest.slice(0, 12)}\n\n确认合并并清理?`
  }
  const mode = freshSession ? `全新 ${action} 会话(保留 worktree/分支/commit)` : action
  return `${agent} 将以高权限执行 ${mode}。\n目标: ${url}\n授权: ${preview.digest.slice(0, 12)}\n\n确认启动?`
}
