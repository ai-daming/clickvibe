export interface DevCommentInput {
  commit: string
  issueNumber: string
  fixedIssues: string[]
  agent: 'codex' | 'claude'
  at: string
}

export interface ReviewCommentInput {
  commit: string
  issueNumber: string
  passed: boolean
  issues: string[]
  agent: 'codex' | 'claude'
  at: string
}

export function buildDevComment(input: DevCommentInput): string {
  const summary =
    input.fixedIssues.length > 0
      ? [
          `已处理上一轮 Review 的 ${input.fixedIssues.length} 个问题:`,
          '',
          ...input.fixedIssues.map((issue) => `- ${issue}`),
        ]
      : ['已完成本轮 Issue 需求实现。']
  return [
    '== Dev Meta ==',
    '- event: dev',
    `- commit: ${input.commit}`,
    `- issue: #${input.issueNumber}`,
    `- fixed: ${input.fixedIssues.length}`,
    '- next: review',
    `- agent: ${input.agent}`,
    `- at: ${input.at}`,
    '',
    '## 🚀 ClickVibe 开发完成',
    '',
    `当前交付提交: \`${input.commit}\``,
    '',
    '### 本次交付摘要',
    '',
    ...summary,
    '',
    '下一步:请 Review 当前提交。',
  ].join('\n')
}

export function buildReviewComment(input: ReviewCommentInput): string {
  const result = input.passed
    ? ['## ✅ ClickVibe Review 通过', '', '未发现阻塞问题。', '', '下一步:可合并当前提交。']
    : [
        `## ❌ ClickVibe Review 发现问题(${input.issues.length} 条)`,
        '',
        ...input.issues.map((issue) => `- ${issue}`),
        '',
        '下一步:请重新开发并处理上述问题。',
      ]
  return [
    '== Review Meta ==',
    '- event: review',
    `- commit: ${input.commit}`,
    `- issue: #${input.issueNumber}`,
    `- passed: ${input.passed}`,
    `- next: ${input.passed ? 'merge' : 'rework'}`,
    `- agent: ${input.agent}`,
    `- at: ${input.at}`,
    '',
    ...result,
  ].join('\n')
}
