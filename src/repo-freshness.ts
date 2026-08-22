export interface RepositoryFreshness {
  stale: boolean
  refreshed: boolean
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
}

interface FreshnessEntry {
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
  inFlight?: Promise<RepositoryFreshness>
}

/**
 * Repository-scoped TTL gate for remote-ref refreshes. Both list and detail
 * reads use the same instance, so polling cannot fan out duplicate fetches.
 * Failed attempts are throttled too; callers keep using local refs and get an
 * explicit stale marker until a later retry succeeds.
 */
export class RepositoryFreshnessGate {
  private readonly entries = new Map<string, FreshnessEntry>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  async ensure(
    key: string,
    ttlMs: number,
    refresh: () => Promise<void>,
    force = false,
  ): Promise<RepositoryFreshness> {
    const existing = this.entries.get(key)
    if (existing?.inFlight) return existing.inFlight

    const now = this.now()
    if (!force && existing && now - existing.lastAttemptAt < ttlMs) {
      return this.snapshot(existing, false)
    }

    const entry: FreshnessEntry = existing ?? { lastAttemptAt: 0, lastSuccessAt: null }
    entry.lastAttemptAt = now
    const inFlight = (async (): Promise<RepositoryFreshness> => {
      try {
        await refresh()
        entry.lastSuccessAt = this.now()
        delete entry.error
      } catch (error) {
        entry.error = String(error instanceof Error ? error.message : error)
      } finally {
        delete entry.inFlight
      }
      return this.snapshot(entry, true)
    })()
    entry.inFlight = inFlight
    this.entries.set(key, entry)
    return inFlight
  }

  clear(): void {
    this.entries.clear()
  }

  private snapshot(entry: FreshnessEntry, refreshed: boolean): RepositoryFreshness {
    return {
      stale: entry.error !== undefined,
      refreshed,
      lastAttemptAt: entry.lastAttemptAt,
      lastSuccessAt: entry.lastSuccessAt,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }
}
