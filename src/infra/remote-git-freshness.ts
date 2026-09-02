/** Freshness state machine embedded by each RemoteGitOwner. */

export interface RemoteGitFreshness {
  stale: boolean
  refreshed: boolean
  refreshing: boolean
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
}

export interface RemoteGitFreshnessEntry {
  lastAttemptAt: number
  lastSuccessAt: number | null
  error?: string
  inFlight?: Promise<RemoteGitFreshness>
}

export interface RemoteGitFreshnessOwner {
  freshness?: RemoteGitFreshnessEntry
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function snapshot(entry: RemoteGitFreshnessEntry, refreshed: boolean): RemoteGitFreshness {
  return {
    stale: entry.error !== undefined,
    refreshed,
    refreshing: entry.inFlight !== undefined,
    lastAttemptAt: entry.lastAttemptAt,
    lastSuccessAt: entry.lastSuccessAt,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  }
}

export async function ensureRemoteGitFreshness(
  owner: RemoteGitFreshnessOwner,
  input: { ttlMs: number; refresh(): Promise<void>; waitMs?: number; force?: boolean },
  now: () => number,
): Promise<RemoteGitFreshness> {
  const existing = owner.freshness
  if (existing?.inFlight) {
    if (input.waitMs !== undefined) return { ...snapshot(existing, false), stale: true, refreshing: true }
    return existing.inFlight
  }
  const currentAt = now()
  if (!input.force && existing && currentAt - existing.lastAttemptAt < input.ttlMs) return snapshot(existing, false)
  const entry = existing ?? { lastAttemptAt: 0, lastSuccessAt: null }
  entry.lastAttemptAt = currentAt
  const pending = (async (): Promise<RemoteGitFreshness> => {
    try {
      await input.refresh()
      entry.lastSuccessAt = now()
      delete entry.error
    } catch (error) {
      entry.error = errorText(error)
    } finally {
      delete entry.inFlight
    }
    return snapshot(entry, true)
  })()
  entry.inFlight = pending
  owner.freshness = entry
  if (input.waitMs === undefined) return pending
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<RemoteGitFreshness>((resolve) => {
    timeout = setTimeout(() => resolve({ ...snapshot(entry, false), stale: true, refreshing: true }), input.waitMs)
  })
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
