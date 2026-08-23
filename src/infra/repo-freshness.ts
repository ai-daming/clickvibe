export interface RepositoryFreshness {
  stale: boolean
  refreshed: boolean
  refreshing: boolean
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
}

export interface AggregatedRepositoryFreshness extends RepositoryFreshness {
  repositoryCount: number
  successfulRepositoryCount: number
  partial: boolean
}

export function aggregateRepositoryFreshness(freshnesses: RepositoryFreshness[]): AggregatedRepositoryFreshness | null {
  if (freshnesses.length === 0) return null
  const successful = freshnesses.filter((value) => value.lastSuccessAt !== null)
  return {
    stale: freshnesses.some((value) => value.stale),
    refreshed: freshnesses.some((value) => value.refreshed),
    refreshing: freshnesses.some((value) => value.refreshing),
    lastAttemptAt: Math.max(...freshnesses.map((value) => value.lastAttemptAt)),
    lastSuccessAt:
      successful.length === 0 ? null : Math.min(...successful.map((value) => value.lastSuccessAt as number)),
    repositoryCount: freshnesses.length,
    successfulRepositoryCount: successful.length,
    partial: successful.length > 0 && successful.length < freshnesses.length,
    error: freshnesses.find((value) => value.error)?.error,
  }
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

  async ensure(key: string, ttlMs: number, refresh: () => Promise<void>, force = false): Promise<RepositoryFreshness> {
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

  /**
   * Wait only for the caller's read budget. A slow fetch stays coalesced in the
   * background while the caller immediately degrades to the last local refs.
   */
  async ensureWithin(
    key: string,
    ttlMs: number,
    refresh: () => Promise<void>,
    waitMs: number,
    force = false,
  ): Promise<RepositoryFreshness> {
    const existing = this.entries.get(key)
    if (existing?.inFlight) {
      return { ...this.snapshot(existing, false), stale: true, refreshing: true }
    }
    const pending = this.ensure(key, ttlMs, refresh, force)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<RepositoryFreshness>((resolve) => {
      timeout = setTimeout(() => {
        const entry = this.entries.get(key)
        resolve(
          entry
            ? { ...this.snapshot(entry, false), stale: true, refreshing: true }
            : { stale: true, refreshed: false, refreshing: true, lastAttemptAt: this.now(), lastSuccessAt: null },
        )
      }, waitMs)
    })
    try {
      return await Promise.race([pending, timedOut])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  private snapshot(entry: FreshnessEntry, refreshed: boolean): RepositoryFreshness {
    return {
      stale: entry.error !== undefined,
      refreshed,
      refreshing: entry.inFlight !== undefined,
      lastAttemptAt: entry.lastAttemptAt,
      lastSuccessAt: entry.lastSuccessAt,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }
}

/** A repo-scoped TTL clock for facts refreshed outside git (GitHub issues). */
export class RepositoryRefreshClock {
  private readonly refreshedAt = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  take(key: string, ttlMs: number, force = false): boolean {
    const now = this.now()
    const previous = this.refreshedAt.get(key)
    if (!force && previous !== undefined && now - previous < ttlMs) return false
    this.refreshedAt.set(key, now)
    return true
  }

  mark(key: string): void {
    this.refreshedAt.set(key, this.now())
  }

  clear(): void {
    this.refreshedAt.clear()
  }
}
