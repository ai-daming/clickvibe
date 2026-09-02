import type { RemoteGitFreshness } from './remote-git-coordinator.ts'

export type RepositoryFreshness = RemoteGitFreshness

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
