import type { IssueContractCheck } from './issue-contract.ts'

export type DependencyState = 'OPEN' | 'CLOSED' | 'UNKNOWN'

export type AutoDevelopmentStatus =
  | 'ready'
  | 'blocked'
  | 'dependency-unknown'
  | 'invalid-contract'
  | 'not-open'
  | 'not-startable'

export interface AutoDevelopmentDecision {
  status: AutoDevelopmentStatus
  ready: boolean
  reason: string
}

export function deriveAutoDevelopment(input: {
  issueState: string
  dependencyStates: string[]
  contract: IssueContractCheck
  nextActionKind: string
}): AutoDevelopmentDecision {
  if (input.issueState.toUpperCase() !== 'OPEN') {
    return { status: 'not-open', ready: false, reason: 'issue 不是 OPEN' }
  }
  if (!input.contract.ok) {
    return {
      status: 'invalid-contract',
      ready: false,
      reason: `契约缺失: ${input.contract.missing.join('、')}`,
    }
  }
  const states = input.dependencyStates.map((state) => state.toUpperCase())
  if (states.some((state) => state === 'OPEN')) {
    return { status: 'blocked', ready: false, reason: '存在未完成的直接依赖' }
  }
  if (states.some((state) => state !== 'CLOSED')) {
    return { status: 'dependency-unknown', ready: false, reason: '依赖状态未知，自动选择已关门' }
  }
  if (input.nextActionKind !== 'develop') {
    return { status: 'not-startable', ready: false, reason: '当前阶段不是首次开发' }
  }
  return { status: 'ready', ready: true, reason: '契约完整且直接依赖均已完成' }
}

export const DEPENDENCY_UNLOCK_MARKER_PREFIX = '<!-- clickvibe:dependency-unlock:'

export function dependencyUnlockMarker(numbers: number[]): string {
  const stable = [...new Set(numbers)].sort((left, right) => left - right)
  return `${DEPENDENCY_UNLOCK_MARKER_PREFIX}${stable.join(',')} -->`
}

export function buildDependencyUnlockComment(input: { issueNumber: number; dependencyNumbers: number[]; at: string }): string {
  const stable = [...new Set(input.dependencyNumbers)].sort((left, right) => left - right)
  const references = stable.map((number) => `#${number}`).join('、')
  return [
    '== Dependency Meta ==',
    '- event: dependency-unlock',
    `- issue: #${input.issueNumber}`,
    `- dependencies: ${stable.map((number) => `#${number}`).join(',')}`,
    '- next: develop',
    `- at: ${input.at}`,
    '',
    dependencyUnlockMarker(stable),
    '## 🔓 ClickVibe 依赖解锁',
    '',
    `依赖 ${references} 已完成，本 issue 解锁。`,
    '',
    '_由 ClickVibe 根据实时 CLOSED 状态自动维护依赖账本。_',
  ].join('\n')
}

/**
 * Replace only the machine-readable dependency section. Historical issue
 * numbers remain visible for humans, while parsers treat the new `依赖: 无`
 * prefix as authoritative and never re-create an edge from the history text.
 */
export function rewriteCompletedDependencySection(body: string, numbers: number[]): string {
  const stable = [...new Set(numbers)].sort((left, right) => left - right)
  if (stable.length === 0) return body
  const lines = body.split('\n')
  const start = lines.findIndex((line) => /^##\s*依赖\s*$/.test(line.trim()))
  if (start === -1) return body
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index].trim())) {
      end = index
      break
    }
  }
  const references = stable.map((number) => `#${number}`).join('、')
  const replacement = [`## 依赖`, '', `依赖: 无(原 Blocked by ${references} 已完成，自动更新)`, '']
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join('\n')
}
