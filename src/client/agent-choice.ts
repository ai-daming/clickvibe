import type { NextActionKind } from './domain.ts'
import { type FreshSessionAvailability, freshSessionEntry } from './fresh-session.ts'

export type CodingAgent = 'codex' | 'claude'

export interface AgentChoicePolicy {
  disabled: boolean
  tooltip: '选择 agent' | '换 agent 需新开会话' | '当前动作无需选择 agent'
  freshEntry: 'develop' | 'review' | null
  continuationAgent: CodingAgent | null
  preferredAgent: CodingAgent
}

/** Keep continuation ownership and fresh-session choice as separate UI facts. */
export function deriveAgentChoicePolicy(
  action: NextActionKind,
  availability: FreshSessionAvailability | null | undefined,
  devAgent: CodingAgent | null | undefined,
  reviewAgent: CodingAgent | null | undefined,
): AgentChoicePolicy {
  const freshEntry = freshSessionEntry(action, availability)
  const continuationAgent =
    action === 'resume' || action === 'rework'
      ? (devAgent ?? 'codex')
      : action === 'review'
        ? (reviewAgent ?? null)
        : null
  const agentAction = action === 'develop' || action === 'resume' || action === 'rework' || action === 'review'
  const disabled = !agentAction || (continuationAgent !== null && freshEntry === null)
  const preferredAgent =
    action === 'review' ? (reviewAgent ?? devAgent ?? 'codex') : (devAgent ?? reviewAgent ?? 'codex')
  return {
    disabled,
    tooltip: !agentAction ? '当前动作无需选择 agent' : disabled ? '换 agent 需新开会话' : '选择 agent',
    freshEntry,
    continuationAgent,
    preferredAgent,
  }
}
