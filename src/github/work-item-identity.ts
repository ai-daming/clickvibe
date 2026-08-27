/** GitHub-specific normalization at the provider adapter boundary. */
import type { WorkItemIdentity } from '../infra/contracts.ts'
import { parseWorkItemIdentity } from '../infra/work-item-identity.ts'

export interface GithubWorkItemCoordinates {
  instance: string
  owner: string
  repository: string
  number: unknown
}

function githubIssueId(number: unknown): string {
  if (typeof number === 'number') {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('GitHub issue number must be a positive integer')
    return String(number)
  }
  if (typeof number !== 'string' || !/^[1-9]\d*$/.test(number)) {
    throw new Error('GitHub issue number must be a positive integer')
  }
  return number
}

function githubName(value: unknown, field: 'owner' | 'repository'): string {
  if (typeof value !== 'string' || !/^[\w.-]+$/.test(value)) {
    throw new Error(`GitHub ${field} must be a non-empty canonical name`)
  }
  return value
}

function githubInstance(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('GitHub instance must be a non-empty host')
  return value.toLowerCase()
}

export function githubWorkItemIdentity(input: GithubWorkItemCoordinates): WorkItemIdentity {
  const owner = githubName(input.owner, 'owner')
  const repository = githubName(input.repository, 'repository')
  return parseWorkItemIdentity({
    provider: 'github',
    instance: githubInstance(input.instance),
    container: `${owner}/${repository}`,
    id: githubIssueId(input.number),
  })
}
