/** Pure ProjectBinding construction and schema-1 config validation. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ClickVibeConfigV1, ProjectBinding, ProjectContainerIdentity } from './contracts.ts'

const TUPLE_TAG = 'clickvibe.project-binding'
const TUPLE_VERSION = 1
const REPOSITORY_ID = /^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function objectValue(value: unknown, contract: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${contract} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], contract: string): void {
  const surplus = Object.keys(input).filter((key) => !allowed.includes(key))
  if (surplus.length > 0) throw new Error(`${contract} contains unknown field(s): ${surplus.join(', ')}`)
}

function nonEmptyString(value: unknown, field: string, contract: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${contract}.${field} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ClickVibeConfigV1.${field} must be a positive integer`)
  }
  return value
}

function absolutePath(value: unknown, field: string, contract: string): string {
  const path = nonEmptyString(value, field, contract)
  if (!isAbsolute(path)) throw new Error(`${contract}.${field} must be an absolute path`)
  return path
}

function parseContainer(value: unknown): ProjectContainerIdentity {
  const input = objectValue(value, 'ProjectBinding.container')
  exactKeys(input, ['provider', 'instance', 'id'], 'ProjectBinding.container')
  return {
    provider: nonEmptyString(input.provider, 'provider', 'ProjectBinding.container'),
    instance: nonEmptyString(input.instance, 'instance', 'ProjectBinding.container'),
    id: nonEmptyString(input.id, 'id', 'ProjectBinding.container'),
  }
}

export function isRepositoryId(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_ID.test(value)
}

export function canonicalProjectBindingIdentity(containerValue: unknown, repositoryIdValue: unknown): string {
  const container = parseContainer(containerValue)
  if (!isRepositoryId(repositoryIdValue)) throw new Error('ProjectBinding.repository.repositoryId is invalid')
  return JSON.stringify([
    TUPLE_TAG,
    TUPLE_VERSION,
    container.provider,
    container.instance,
    container.id,
    repositoryIdValue,
  ])
}

export function projectBindingKey(container: unknown, repositoryId: unknown): string {
  const canonical = canonicalProjectBindingIdentity(container, repositoryId)
  return `pb1_${createHash('sha256').update(canonical, 'utf8').digest('base64url')}`
}

export function parseProjectBinding(value: unknown): ProjectBinding {
  const input = objectValue(value, 'ProjectBinding')
  exactKeys(input, ['schemaVersion', 'bindingId', 'container', 'repository'], 'ProjectBinding')
  if (input.schemaVersion !== 1) throw new Error('ProjectBinding.schemaVersion must be 1')
  const container = parseContainer(input.container)
  const repository = objectValue(input.repository, 'ProjectBinding.repository')
  exactKeys(repository, ['repositoryId', 'localPath', 'primaryRemote'], 'ProjectBinding.repository')
  const repositoryId = nonEmptyString(repository.repositoryId, 'repositoryId', 'ProjectBinding.repository')
  if (!isRepositoryId(repositoryId)) throw new Error('ProjectBinding.repository.repositoryId is invalid')
  const bindingId = nonEmptyString(input.bindingId, 'bindingId', 'ProjectBinding')
  const expectedBindingId = projectBindingKey(container, repositoryId)
  if (bindingId !== expectedBindingId) throw new Error(`ProjectBinding.bindingId does not match ${expectedBindingId}`)
  return {
    schemaVersion: 1,
    bindingId,
    container,
    repository: {
      repositoryId,
      localPath: absolutePath(repository.localPath, 'localPath', 'ProjectBinding.repository'),
      primaryRemote: nonEmptyString(repository.primaryRemote, 'primaryRemote', 'ProjectBinding.repository'),
    },
  }
}

export function createProjectBinding(value: Omit<ProjectBinding, 'schemaVersion' | 'bindingId'>): ProjectBinding {
  return parseProjectBinding({
    ...value,
    schemaVersion: 1,
    bindingId: projectBindingKey(value.container, value.repository.repositoryId),
  })
}

export function parseClickVibeConfigV1(value: unknown): ClickVibeConfigV1 {
  const input = objectValue(value, 'ClickVibeConfigV1')
  exactKeys(
    input,
    ['schemaVersion', 'worktreeRoot', 'fetchTtlSeconds', 'diagnosticsMaxBytes', 'projectBindings'],
    'ClickVibeConfigV1',
  )
  if (input.schemaVersion !== 1) throw new Error('ClickVibeConfigV1.schemaVersion must be 1')
  if (!Array.isArray(input.projectBindings)) {
    throw new Error('ClickVibeConfigV1.projectBindings must be an array')
  }
  const projectBindings = input.projectBindings.map(parseProjectBinding)
  const containers = new Set<string>()
  const repositoryIds = new Set<string>()
  for (const binding of projectBindings) {
    const containerKey = JSON.stringify([binding.container.provider, binding.container.instance, binding.container.id])
    if (containers.has(containerKey)) {
      throw new Error(`ProjectBinding container ${binding.container.id} has more than one active Binding`)
    }
    if (repositoryIds.has(binding.repository.repositoryId)) {
      throw new Error(`ProjectBinding repositoryId ${binding.repository.repositoryId} must be unique`)
    }
    containers.add(containerKey)
    repositoryIds.add(binding.repository.repositoryId)
  }
  const fetchTtlSeconds = positiveInteger(input.fetchTtlSeconds, 'fetchTtlSeconds')
  if (fetchTtlSeconds !== undefined && (fetchTtlSeconds < 30 || fetchTtlSeconds > 60)) {
    throw new Error('ClickVibeConfigV1.fetchTtlSeconds must be between 30 and 60')
  }
  const diagnosticsMaxBytes = positiveInteger(input.diagnosticsMaxBytes, 'diagnosticsMaxBytes')
  return {
    schemaVersion: 1,
    worktreeRoot: absolutePath(input.worktreeRoot, 'worktreeRoot', 'ClickVibeConfigV1'),
    ...(fetchTtlSeconds === undefined ? {} : { fetchTtlSeconds }),
    ...(diagnosticsMaxBytes === undefined ? {} : { diagnosticsMaxBytes }),
    projectBindings,
  }
}
