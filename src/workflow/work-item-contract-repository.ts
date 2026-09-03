/** The single answering source for current Work Item contract observations. */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptSnapshot, WorkItemContractSnapshot, WorkItemIdentity } from '../infra/contracts.ts'
import {
  createRawArtifactRef,
  publishWorkItemContractCapture,
  readCurrentWorkItemContract,
  type WorkItemContractPublication,
  type WorkItemContractRead,
} from '../infra/work-item-contract-store.ts'
import { encodeGithubContractRawObservation, parseGithubWorkItemContract } from '../github/work-item-contract.ts'
import { issueSnapshot } from '../github/issue.ts'
import { fetchIssue } from '../github/issue.ts'
import { stateDir } from '../infra/state.ts'
import { appendDiagnosticRecord, diagnosticRecordForError } from '../infra/diagnostic-record.ts'
import { DEFAULT_DIAGNOSTIC_MAX_BYTES } from '../infra/diagnostic-log-store.ts'
import { githubWorkItemIdentity } from '../github/work-item-identity.ts'
import { fingerprintWorkItemContract } from './work-item-contract.ts'

interface MaterializeGithubContractInput {
  root: string
  item: Record<string, unknown>
  blockedBy: readonly { number: number; title: string; state: string }[]
  capturedAt: string
}

export type CurrentIssueContract =
  | (Extract<WorkItemContractRead, { state: 'known' }> & { prompt: PromptSnapshot })
  | { state: 'unknown'; reason: string }

function compareGithubSourceVersion(current: string, candidate: string): number | null {
  const currentTime = Date.parse(current)
  const candidateTime = Date.parse(candidate)
  if (!Number.isFinite(currentTime) || !Number.isFinite(candidateTime)) return current === candidate ? 0 : null
  return currentTime === candidateTime ? 0 : currentTime < candidateTime ? -1 : 1
}

function workItemFromIssueUrl(url: string) {
  const parsed = new URL(url)
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/)
  if (!match) throw new Error('GitHub Issue URL is invalid')
  return githubWorkItemIdentity({ instance: parsed.host, owner: match[1], repository: match[2], number: match[3] })
}

async function preserveContractDiagnostic(root: string, url: string, operation: string, error: unknown): Promise<void> {
  try {
    await appendDiagnosticRecord(
      root,
      diagnosticRecordForError({
        workItem: workItemFromIssueUrl(url),
        operation,
        classification: 'work-item-contract-unknown',
        error,
      }),
      DEFAULT_DIAGNOSTIC_MAX_BYTES,
    )
  } catch {
    // The caller still returns the original contract failure; diagnostics cannot turn unknown into success.
  }
}

export function contractHasKnownCanonicalFields(snapshot: WorkItemContractSnapshot): boolean {
  return (
    snapshot.goal.state === 'known' &&
    snapshot.acceptanceCriteria.state === 'known' &&
    snapshot.dependencies.state === 'known' &&
    snapshot.nonGoals.state === 'known' &&
    snapshot.constraints.state === 'known'
  )
}

export function fingerprintGithubIssueContract(item: Record<string, unknown>): `wic1_${string}` {
  const parsed = parseGithubWorkItemContract(item)
  return fingerprintWorkItemContract({
    ...parsed,
    capturedAt: '',
    rawArtifact: {
      artifactId: '',
      kind: 'issue-snapshot',
      path: '',
      contentHash: 'sha256-v1_',
      redaction: 'none',
    },
  })
}

export async function materializeGithubWorkItemContract(
  input: MaterializeGithubContractInput,
): Promise<WorkItemContractPublication> {
  const parsed = parseGithubWorkItemContract(input.item, input.blockedBy)
  const raw = encodeGithubContractRawObservation(input.item, input.blockedBy, input.capturedAt)
  const snapshot: WorkItemContractSnapshot = {
    ...parsed,
    fingerprint: 'wic1_pending',
    capturedAt: input.capturedAt,
    rawArtifact: createRawArtifactRef(parsed.workItem, raw, input.root),
  }
  snapshot.fingerprint = fingerprintWorkItemContract(snapshot)
  return publishWorkItemContractCapture({
    root: input.root,
    workItem: snapshot.workItem,
    raw,
    snapshot,
    fingerprintOf: fingerprintWorkItemContract,
    compareSourceVersion: compareGithubSourceVersion,
  })
}

export async function captureGithubIssueContractObservation(
  input: MaterializeGithubContractInput,
): Promise<CurrentIssueContract> {
  const url = String(input.item.url ?? input.item.html_url ?? '')
  try {
    const publication = await materializeGithubWorkItemContract(input)
    if (publication.state !== 'known') {
      await preserveContractDiagnostic(input.root, url, 'publish-contract-capture', publication.reason)
      return publication
    }
    return { ...publication, prompt: promptSnapshotFromContract(publication) }
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error)
    await preserveContractDiagnostic(input.root, url, 'materialize-contract-capture', error)
    return { state: 'unknown', reason }
  }
}

export async function readCurrentIssueContract(url: string, root = stateDir()): Promise<CurrentIssueContract> {
  let workItem: WorkItemIdentity
  try {
    workItem = workItemFromIssueUrl(url)
  } catch (error) {
    return { state: 'unknown', reason: String(error instanceof Error ? error.message : error) }
  }
  const current = await readCurrentWorkItemContract({ root, workItem, fingerprintOf: fingerprintWorkItemContract })
  if (current.state !== 'known') {
    if (current.reason !== 'missing-current-contract') {
      await preserveContractDiagnostic(root, url, 'read-current-contract', current.reason)
    }
    return current
  }
  try {
    return { ...current, prompt: promptSnapshotFromContract(current) }
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error)
    await preserveContractDiagnostic(root, url, 'read-current-contract', error)
    return { state: 'unknown', reason }
  }
}

export function promptSnapshotFromContract(bundle: Extract<WorkItemContractRead, { state: 'known' }>): PromptSnapshot {
  const raw = JSON.parse(bundle.raw.toString('utf8')) as { schemaVersion?: unknown; item?: unknown }
  if (raw.schemaVersion !== 1 || !raw.item || typeof raw.item !== 'object' || Array.isArray(raw.item)) {
    throw new Error('Work Item contract raw artifact is invalid')
  }
  return issueSnapshot(raw.item as Record<string, unknown>)
}

export function dependencyStatesFromContract(
  bundle: Extract<WorkItemContractRead, { state: 'known' }>,
): string[] | null {
  try {
    const raw = JSON.parse(bundle.raw.toString('utf8')) as { schemaVersion?: unknown; blockedBy?: unknown }
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.blockedBy)) return null
    const states = raw.blockedBy.map((dependency) =>
      typeof dependency === 'object' && dependency !== null ? (dependency as { state?: unknown }).state : null,
    )
    return states.every((state): state is string => typeof state === 'string') ? states : null
  } catch {
    return null
  }
}

export async function observeCurrentIssueContract(
  ctx: Context,
  url: string,
  options: { force?: boolean; root?: string; capturedAt?: string } = {},
): Promise<CurrentIssueContract> {
  const root = options.root ?? stateDir()
  const fetched = await fetchIssue(ctx, {
    url,
    forceRefresh: options.force === true,
    forceDependencyRefresh: options.force === true,
  })
  if (!fetched.ok) {
    await preserveContractDiagnostic(root, url, 'observe-current-contract', fetched.error)
    return { state: 'unknown', reason: fetched.error }
  }
  if (fetched.data.kind !== 'issue') {
    await preserveContractDiagnostic(root, url, 'observe-current-contract', 'Work Item contract requires an Issue')
    return { state: 'unknown', reason: 'Work Item contract requires an Issue' }
  }
  if (!fetched.data.dependencies) {
    const reason = fetched.dependencyError ?? 'Issue dependency observation is unavailable'
    await preserveContractDiagnostic(root, url, 'observe-current-contract', reason)
    return { state: 'unknown', reason }
  }
  return captureGithubIssueContractObservation({
    root,
    item: fetched.data.item as Record<string, unknown>,
    blockedBy: fetched.data.dependencies.blockedBy,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  })
}
