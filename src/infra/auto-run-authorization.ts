export interface AutoRunAuthorizationConfig {
  autoMerge: boolean
  devAgent: 'codex' | 'claude'
  reviewAgent: 'codex' | 'claude'
  maxRounds: number
  budgetHours: number
}

export function parseAutoRunAuthorization(value: unknown): AutoRunAuthorizationConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  const devAgent = String(raw.devAgent ?? '')
  const reviewAgent = String(raw.reviewAgent ?? '')
  const maxRounds = Number(raw.maxRounds)
  const budgetHours = Number(raw.budgetHours)
  if (devAgent !== 'codex' && devAgent !== 'claude') throw new Error('开发 agent 无效')
  if (reviewAgent !== 'codex' && reviewAgent !== 'claude') throw new Error('Review agent 无效')
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) throw new Error('轮次上限必须是正整数')
  if (!Number.isFinite(budgetHours) || budgetHours <= 0) throw new Error('总预算必须是正数')
  return { autoMerge: raw.autoMerge === true, devAgent, reviewAgent, maxRounds, budgetHours }
}
