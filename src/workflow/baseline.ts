/** Workflow-only baseline preview and issue dependency guidance. */
import { requestedRemoteBase } from '../agent/baseline.ts'

export { frozenBaseHash, frozenRemoteBase, requestedRemoteBase, resolveSelectedRemoteBase } from '../agent/baseline.ts'

/** Default sentinel first; remaining fetched remote branches are stable and unique. */
export function baselinePreviewOptions(actualDefault: string, remoteRefs: string[]): string[] {
  const refs = new Set<string>()
  for (const candidate of [actualDefault, ...remoteRefs]) {
    try {
      const ref = requestedRemoteBase(candidate)
      if (ref !== 'origin/HEAD') refs.add(ref)
    } catch {
      // Git output is treated as data; malformed entries are excluded from the preview.
    }
  }
  return ['origin/HEAD', ...[...refs].sort((left, right) => left.localeCompare(right))]
}

/** Recognize a selected ClickVibe issue-development branch for dependency guidance. */
export function baselineDependencyIssue(remoteBase: string): number | null {
  const match = requestedRemoteBase(remoteBase).match(/(?:^|\/)clickvibe-issue-(\d+)$/)
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
