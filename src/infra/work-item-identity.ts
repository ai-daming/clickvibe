/** Pure canonicalization and hashing for provider-neutral Work Item identity. */
import { createHash } from 'node:crypto'
import type { WorkItemIdentity } from './contracts.ts'

const TUPLE_TAG = 'clickvibe.work-item-identity'
const TUPLE_VERSION = 1

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WorkItemIdentity must be an object')
  }
  return value as Record<string, unknown>
}

function identityField(value: unknown, field: keyof WorkItemIdentity): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`WorkItemIdentity.${field} must be a non-empty string`)
  }
  return value
}

export function parseWorkItemIdentity(value: unknown): WorkItemIdentity {
  const input = record(value)
  const surplus = Object.keys(input).filter((key) => !['provider', 'instance', 'container', 'id'].includes(key))
  if (surplus.length > 0) throw new Error(`WorkItemIdentity contains unknown field(s): ${surplus.join(', ')}`)
  return {
    provider: identityField(input.provider, 'provider'),
    instance: identityField(input.instance, 'instance'),
    container: identityField(input.container, 'container'),
    id: identityField(input.id, 'id'),
  }
}

export function canonicalWorkItemIdentity(value: unknown): string {
  const identity = parseWorkItemIdentity(value)
  return JSON.stringify([
    TUPLE_TAG,
    TUPLE_VERSION,
    identity.provider,
    identity.instance,
    identity.container,
    identity.id,
  ])
}

export function workItemKey(value: unknown): string {
  const canonical = canonicalWorkItemIdentity(value)
  return `wi1_${createHash('sha256').update(canonical, 'utf8').digest('base64url')}`
}
