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
  if (typeof number !== 'string' || number.length > 16 || !/^[1-9]\d*$/.test(number)) {
    throw new Error('GitHub issue number must be a positive integer')
  }
  if (BigInt(number) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('GitHub issue number must be a positive integer within the safe range')
  }
  return number
}

function githubName(value: unknown, field: 'owner' | 'repository'): string {
  const validOwner =
    field === 'owner' &&
    typeof value === 'string' &&
    value.length <= 39 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)
  const validRepository =
    field === 'repository' &&
    typeof value === 'string' &&
    value.length <= 100 &&
    value !== '.' &&
    value !== '..' &&
    /^[\w.-]+$/.test(value)
  if (!validOwner && !validRepository) {
    throw new Error(`GitHub ${field} must be a non-empty canonical name`)
  }
  return (value as string).toLowerCase()
}

function githubInstance(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > 255) {
    throw new Error('GitHub instance must be a canonical host')
  }
  try {
    const url = new URL(`https://${value}`)
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.host === ''
    ) {
      throw new Error('not a host')
    }
    return url.host.toLowerCase()
  } catch {
    throw new Error('GitHub instance must be a canonical host')
  }
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
