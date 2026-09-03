/** GitHub Issue adapter for the repository-owned Work Item contract grammar. */
import type {
  AcceptanceCriterion,
  ContractField,
  WorkItemContractSnapshot,
  WorkItemIdentity,
} from '../infra/contracts.ts'
import { githubWorkItemIdentity } from './work-item-identity.ts'

export type ParsedGithubWorkItemContract = Pick<
  WorkItemContractSnapshot,
  | 'schemaVersion'
  | 'canonicalizationVersion'
  | 'workItem'
  | 'sourceVersion'
  | 'goal'
  | 'acceptanceCriteria'
  | 'nonGoals'
  | 'constraints'
  | 'dependencies'
  | 'architectureImpact'
>

interface DependencyObservation {
  number: number
  title: string
  state: string
}

export interface GithubContractRawObservation {
  schemaVersion: 1
  provider: 'github'
  sourceVersion: string
  item: Record<string, unknown>
  blockedBy: readonly DependencyObservation[]
}

export function encodeGithubContractRawObservation(
  item: Record<string, unknown>,
  blockedBy: readonly DependencyObservation[],
  _capturedAt: string,
): Buffer {
  const observation: GithubContractRawObservation = {
    schemaVersion: 1,
    provider: 'github',
    sourceVersion: String(item.updatedAt ?? item.updated_at ?? ''),
    item,
    blockedBy,
  }
  return Buffer.from(JSON.stringify(observation), 'utf8')
}

function section(body: string, heading: string): string | null {
  const match = body.match(new RegExp(`^##\\s*${heading}\\s*$`, 'm'))
  if (!match || match.index === undefined) return null
  const rest = body.slice(match.index + match[0].length)
  const next = rest.match(/^##(?!#)/m)
  return (next ? rest.slice(0, next.index ?? 0) : rest).trim()
}

function scalarSection(body: string, heading: string): ContractField<string> {
  const value = section(body, heading)
  if (value === null) return { state: 'unknown', reason: 'missing' }
  if (value.trim() === '') return { state: 'unknown', reason: 'unparseable' }
  return { state: 'known', value }
}

function stringListSection(body: string, heading: string): ContractField<string[]> {
  const value = section(body, heading)
  if (value === null) return { state: 'unknown', reason: 'missing' }
  if (/^(?:无|none)(?:\s|\(|（|$)/i.test(value)) return { state: 'known', value: [] }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean)
  return lines.length > 0 ? { state: 'known', value: lines } : { state: 'unknown', reason: 'unparseable' }
}

function acceptanceSection(body: string): ContractField<AcceptanceCriterion[]> {
  const value = section(body, '验收标准')
  if (value === null) return { state: 'unknown', reason: 'missing' }
  const criteria: AcceptanceCriterion[] = []
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[[ xX]\]\s*(.+?)\s*$/)
    if (!match) continue
    let description = match[1]
    let verificationAuthority: AcceptanceCriterion['verificationAuthority'] = 'agent'
    const prefix = description.match(/^\[([^\]]+)\]\s*/)
    if (prefix) {
      if (prefix[1] === '人工') verificationAuthority = 'human'
      else if (prefix[1] === '外部') verificationAuthority = 'external'
      else return { state: 'unknown', reason: 'unparseable' }
      description = description.slice(prefix[0].length)
    }
    if (description.trim() === '') return { state: 'unknown', reason: 'unparseable' }
    criteria.push({ description, verificationAuthority })
  }
  return criteria.length > 0 ? { state: 'known', value: criteria } : { state: 'unknown', reason: 'unparseable' }
}

function issueIdentity(item: Record<string, unknown>): WorkItemIdentity {
  const url = new URL(String(item.url ?? item.html_url ?? ''))
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/)
  if (!match) throw new Error('GitHub Issue URL is invalid')
  return githubWorkItemIdentity({ instance: url.host, owner: match[1], repository: match[2], number: match[3] })
}

function bodyDependencyIds(body: string): number[] | null {
  const value = section(body, '依赖')
  if (value === null) return null
  if (/^(?:依赖\s*:\s*)?(?:无|none)(?:\s|\(|（|$)/i.test(value)) return []
  if (!/Blocked by/i.test(value)) return null
  const ids = [...value.matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1]))
  return ids.length > 0 && ids.every(Number.isSafeInteger) ? [...new Set(ids)].sort((a, b) => a - b) : null
}

function dependencyField(
  body: string,
  workItem: WorkItemIdentity,
  observed?: readonly DependencyObservation[],
): ContractField<WorkItemIdentity[]> {
  const bodyIds = bodyDependencyIds(body)
  if (bodyIds === null) return { state: 'unknown', reason: section(body, '依赖') === null ? 'missing' : 'unparseable' }
  const observedIds = observed?.map((item) => item.number).sort((a, b) => a - b)
  if (observedIds && JSON.stringify([...new Set(observedIds)]) !== JSON.stringify(bodyIds)) {
    return { state: 'unknown', reason: 'conflicting' }
  }
  return { state: 'known', value: bodyIds.map((id) => ({ ...workItem, id: String(id) })) }
}

function architectureImpact(body: string): WorkItemContractSnapshot['architectureImpact'] {
  return (
    (body.match(/架构影响等级\s*[：:]\s*(L[0-3])\b/i)?.[1]?.toUpperCase() as
      | WorkItemContractSnapshot['architectureImpact']
      | undefined) ?? 'unknown'
  )
}

export function parseGithubWorkItemContract(
  item: Record<string, unknown>,
  blockedBy?: readonly DependencyObservation[],
): ParsedGithubWorkItemContract {
  const body = String(item.body ?? '')
  const workItem = issueIdentity(item)
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    workItem,
    sourceVersion: String(item.updatedAt ?? item.updated_at ?? ''),
    goal: scalarSection(body, '目标'),
    acceptanceCriteria: acceptanceSection(body),
    nonGoals: stringListSection(body, '非目标'),
    constraints: stringListSection(body, '约束'),
    dependencies: dependencyField(body, workItem, blockedBy),
    architectureImpact: architectureImpact(body),
  }
}
