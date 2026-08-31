/**
 * The Gateway observation cache (design §11): resources, aggregates,
 * versions and forced-flight tracking live in one class so readers never
 * touch raw cache state. Extracted from the owner (review r9 size split);
 * the owner delegates every operation.
 */

export interface CachedValue<T> {
  value: T
  version: string | null
  expiresAt: number
}

export class GatewayCache {
  readonly resources = new Map<string, CachedValue<unknown>>()
  readonly aggregates = new Map<string, CachedValue<unknown>>()
  readonly versions = new Map<string, string>()
  readonly forcedResources = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  readonly inFlight = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  readonly aggregateGenerations = new Map<string, number>()
  readonly resourceLoadSequence = new Map<string, number>()

  rememberVersion(key: string, version: string | null | undefined): void {
    if (version) this.versions.set(key, version)
  }

  resourceVersion(key: string): string | null {
    return this.versions.get(key) ?? null
  }

  invalidate(prefix: string): void {
    for (const key of this.resources.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.resources.delete(key)
    }
    for (const key of this.aggregates.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.aggregates.delete(key)
        this.aggregateGenerations.set(key, (this.aggregateGenerations.get(key) ?? 0) + 1)
      }
    }
    this.versions.delete(prefix)
    for (const key of this.forcedResources.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.forcedResources.delete(key)
    }
    for (const key of this.resourceLoadSequence.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.resourceLoadSequence.delete(key)
    }
  }
}
