/**
 * Write confirmation transactions (issue #131 slice B, ADR-0010 §5/§9).
 *
 * One production primitive owns the whole write lifecycle: the affected
 * resources' exclusive lease (acquired atomically as a sorted set), the
 * durable attempt marker persisted by the CALLER before any dispatch, the
 * single write attempt, the generation invalidation, the single
 * authoritative readback and the predicate comparison that alone may publish
 * `confirmed`. Explicit 4xx rejections that provably never executed are
 * `failed`; transport loss, readback failure and predicate mismatches stay
 * `unknown` — an unprovable write is never guessed into success or failure.
 * Restart recovery runs the readback ONLY (githubWriteRecover): a
 * non-repeatable write is never re-dispatched.
 *
 * The family registry (githubWrite) migrates the call sites family by
 * family; runWriteTransaction stays the single transaction engine.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type GithubGatewayOwner, GatewayClosedError } from './gateway-contracts.ts'
import { GithubRestHttpError, GithubRestReader } from './rest.ts'

export type GithubWriteOutcome<T> =
  | { outcome: 'confirmed'; value: T }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'unknown'; error: unknown }

/** One declared write family: dispatch + affected resources + the predicate
 *  that alone confirms the effect (design §5/§9). */
export interface GithubWriteSpec<TInput, TDispatch> {
  id: string
  /** Cache keys whose leases the transaction holds and whose observations it
   *  invalidates — include the `repo:` aggregate when the write affects it. */
  keys: (input: TInput) => string[]
  priority: 'critical' | 'normal'
  deadlineMs: number
  maxPages: number
  /** Idempotent writes (e.g. a body-setting PATCH) may retry without a durable
   *  marker; non-repeatable writes MUST persist one before dispatch. */
  repeatable: boolean
  /** Exactly one write attempt, expressed as a REST mutation. */
  dispatch: (reader: GithubRestReader, input: TInput) => Promise<TDispatch>
  /** The authoritative upstream-confirmed readback and its predicate. */
  readback: {
    run: (reader: GithubRestReader, input: TInput) => Promise<unknown>
    confirms: (input: TInput, observation: unknown) => boolean
  }
}

export interface GithubWriteOptions {
  /** Persist the attempt marker in the caller's workflow/action state; the
   *  transaction dispatches ONLY after this resolves (ADR-0010 §9). */
  persistMarker?: () => Promise<void>
}

const errorText = (error: unknown): string | null =>
  error instanceof Error ? error.message : error === undefined ? null : String(error)

const isProvableRejection = (error: unknown): boolean =>
  error instanceof GithubRestHttpError && error.status >= 400 && error.status < 500 && error.status !== 429

/** Run the readback half alone and classify confirmed/unknown (design §9
 *  restart recovery: readback ONLY, zero write dispatch). The readback is
 *  jointly admitted with the write's own budget (design §9). */
export async function githubWriteRecover<TInput, TDispatch>(
  owner: GithubGatewayOwner,
  reader: GithubRestReader,
  spec: GithubWriteSpec<TInput, TDispatch>,
  input: TInput,
): Promise<GithubWriteOutcome<TDispatch>> {
  const requestId = owner.declareLogicalRequest('write', `${spec.id}:recover`)
  return owner.runLogicalWrite(requestId, async () => {
    try {
      const observation = await owner.runWithAdmission(
        { priority: spec.priority, deadlineMs: spec.deadlineMs, maxPages: spec.maxPages },
        () =>
          owner.runWithRequest(requestId, () => owner.runWithLeaseExemption(() => spec.readback.run(reader, input))),
      )
      const confirmed = spec.readback.confirms(input, observation)
      owner.noteReadbackSettled(requestId, confirmed)
      owner.noteTerminal(requestId, confirmed ? 'succeeded' : 'unknown', confirmed ? undefined : '回读未证实预期事实')
      return confirmed
        ? ({ outcome: 'confirmed', value: undefined as TDispatch } as { outcome: 'confirmed'; value: TDispatch })
        : { outcome: 'unknown', error: new Error('回读未证实预期事实') }
    } catch (error) {
      owner.noteReadbackSettled(requestId, false)
      if (error instanceof GatewayClosedError) {
        // The authoritative read provably never dispatched: one interrupted
        // terminal, caller failed — recovery simply retries at the next
        // claim (review CF1: settlement maps to both answers).
        owner.noteTerminal(requestId, 'interrupted', errorText(error))
        return { outcome: 'failed', error }
      }
      owner.noteTerminal(requestId, 'unknown', errorText(error))
      return { outcome: 'unknown', error }
    }
  })
}

/** The write confirmation transaction (ADR-0010 §9). */
export async function runWriteTransaction<TInput, TDispatch>(
  owner: GithubGatewayOwner,
  reader: GithubRestReader,
  spec: GithubWriteSpec<TInput, TDispatch>,
  input: TInput,
  options: GithubWriteOptions = {},
): Promise<GithubWriteOutcome<TDispatch>> {
  const leaseKeys = [...new Set(spec.keys(input))].sort()
  // The logical request is declared BEFORE blocking on the lease queue: the
  // write is visible to the lifecycle stream while it waits, and close()
  // settles a queued acquisition with one interrupted terminal (review F2).
  // Every path after a successful acquisition runs inside the finally that
  // releases the lease — no reject path may strand it.
  const requestId = owner.declareLogicalRequest('write', `${spec.id}:${leaseKeys[0] ?? spec.id}`)
  // The whole transaction is tracked as one logical write (review CF1):
  // close() drains it within its window, and an unsettled transaction at the
  // deadline is swept unknown once its dispatch was attempted.
  return owner.runLogicalWrite(requestId, async () => {
    let release: (() => void) | null = null
    try {
      try {
        release = await owner.acquireWriteLeases(leaseKeys, requestId)
      } catch (queuedError) {
        // close() interrupted the queued acquisition and already emitted the
        // single interrupted terminal — only propagate.
        throw queuedError
      }
      if (!spec.repeatable) {
        if (!options.persistMarker) {
          const error = new Error(`写操作 ${spec.id} 不可重复,必须提供 attempt marker 持久化钩子`)
          owner.noteTerminal(requestId, 'failed', error.message)
          return { outcome: 'failed', error }
        }
        try {
          await options.persistMarker()
        } catch (markerError) {
          // Marker persistence failed before any dispatch: the write provably
          // never happened (ADR-0010 §9 — marker 落盘前不得派发).
          owner.noteTerminal(requestId, 'failed', errorText(markerError))
          return { outcome: 'failed', error: markerError }
        }
      }

      let dispatched: TDispatch
      try {
        owner.noteWriteDispatchAttempted(requestId)
        dispatched = await owner.runWithAdmission(
          { priority: spec.priority, deadlineMs: spec.deadlineMs, maxPages: spec.maxPages },
          () => owner.runWithRequest(requestId, () => spec.dispatch(reader, input)),
        )
      } catch (dispatchError) {
        if (dispatchError instanceof GatewayClosedError) {
          // The rejection provably never dispatched (submit-time or queue
          // interrupt): one interrupted terminal, caller sees the write did
          // not happen (review CF1 alignment).
          owner.noteTerminal(requestId, 'interrupted', errorText(dispatchError))
          return { outcome: 'failed', error: dispatchError }
        }
        if (isProvableRejection(dispatchError)) {
          owner.noteTerminal(requestId, 'failed', errorText(dispatchError))
          return { outcome: 'failed', error: dispatchError }
        }
        // Uncertain outcome: the write may or may not have executed on GitHub.
        // Invalidate, then let the authoritative readback alone decide.
        return await settleUncertain(owner, reader, spec, input, requestId, dispatchError)
      }

      // Even a successful response is not confirmation by itself — the
      // invalidation and readback always run (design §9).
      return await settleUncertain(owner, reader, spec, input, requestId, null, dispatched)
    } finally {
      release?.()
    }
  })
}

async function settleUncertain<TInput, TDispatch>(
  owner: GithubGatewayOwner,
  reader: GithubRestReader,
  spec: GithubWriteSpec<TInput, TDispatch>,
  input: TInput,
  requestId: string,
  dispatchError: unknown,
  dispatched?: TDispatch,
): Promise<GithubWriteOutcome<TDispatch>> {
  const leaseKeys = [...new Set(spec.keys(input))].sort()
  for (const key of leaseKeys) owner.invalidate(key)
  owner.noteWriteInvalidated(requestId, leaseKeys)
  try {
    // The mandatory readback shares the write's declared admission budget
    // (design §9: 写 step 与强制 readback 共同准入) — a paginated readback
    // honors the same cost bound instead of streaming unbounded pages.
    const observation = await owner.runWithAdmission(
      { priority: spec.priority, deadlineMs: spec.deadlineMs, maxPages: spec.maxPages },
      () => owner.runWithRequest(requestId, () => owner.runWithLeaseExemption(() => spec.readback.run(reader, input))),
    )
    const confirmed = spec.readback.confirms(input, observation)
    owner.noteReadbackSettled(requestId, confirmed)
    if (confirmed) {
      owner.noteTerminal(requestId, 'succeeded')
      return { outcome: 'confirmed', value: dispatched as TDispatch }
    }
    const dispatchDetail =
      dispatchError === null || dispatchError === undefined
        ? ''
        : ` (写尝试错误: ${errorText(dispatchError) ?? 'unknown'})`
    const error = new Error(`写后回读未证实预期事实${dispatchDetail}`)
    owner.noteTerminal(requestId, 'unknown', error.message)
    return { outcome: 'unknown', error }
  } catch (readbackError) {
    owner.noteReadbackSettled(requestId, false)
    owner.noteTerminal(requestId, 'unknown', errorText(readbackError))
    return { outcome: 'unknown', error: readbackError }
  }
}

// ---------------------------------------------------------------------------
// Family registry (slice B). Each spec is the design §11 migration row for
// its call sites: dispatch REST shape, affected resources (lease +
// invalidation), readback source and the predicate that alone confirms.

export type GithubWriteOperationId =
  | 'issue-comment-create'
  | 'comment-edit'
  | 'issue-update'
  | 'issue-close'
  | 'dependency-unlock-comment'
  | 'pr-review-approve'
  | 'pr-merge'
  | 'pr-create'

const issueKeys = (repoKey: string, number: number) => [`${repoKey}/issues/${number}`, `repo:${repoKey}`]

interface CommentCreateInput {
  repoKey: string
  number: number
  body: string
}
interface CommentEditInput {
  repoKey: string
  commentId: number
  body: string
  /** Issue number owning the comment (invalidation scope). */
  issueNumber: number
}
interface IssueCloseInput {
  repoKey: string
  number: number
}
interface IssueUpdateInput {
  repoKey: string
  number: number
  body: string
}
interface DependencyUnlockCommentInput {
  repoKey: string
  number: number
  /** Substring identifying the unlock comment family (dependency numbers). */
  marker: string
  body: string
}
interface PrCreateInput {
  repoKey: string
  branch: string
  base: string
  title: string
  body: string
}
interface PrMergeInput {
  repoKey: string
  number: number
  headRefOid: string
  issueNumber: number
}

const commentCreateSpec: GithubWriteSpec<CommentCreateInput, { id: number; html_url?: string }> = {
  id: 'issue-comment-create',
  keys: (input) => issueKeys(input.repoKey, input.number),
  priority: 'normal',
  deadlineMs: 30_000,
  maxPages: 2,
  repeatable: false,
  dispatch: (reader, input) =>
    reader.mutate<{ id: number; html_url?: string }>(`repos/${input.repoKey}/issues/${input.number}/comments`, 'POST', {
      body: input.body,
    }),
  readback: {
    // Paginated: issues accumulate comments beyond one default page — the
    // authoritative result set is read within the declared page budget.
    run: (reader, input) =>
      reader.paginate<{ id: number; body: string }>(`repos/${input.repoKey}/issues/${input.number}/comments`),
    confirms: (input, observation) =>
      Array.isArray(observation) && observation.some((entry) => entry.body === input.body),
  },
}

const commentEditSpec: GithubWriteSpec<CommentEditInput, unknown> = {
  id: 'comment-edit',
  keys: (input) => issueKeys(input.repoKey, input.issueNumber),
  priority: 'normal',
  deadlineMs: 30_000,
  maxPages: 2,
  // Setting the full comment body is idempotent: a re-dispatch converges to
  // the same content instead of duplicating anything.
  repeatable: true,
  dispatch: (reader, input) =>
    reader.mutate(`repos/${input.repoKey}/issues/comments/${input.commentId}`, 'PATCH', {
      body: input.body,
    }),
  readback: {
    run: (reader, input) => reader.json<{ body: string }>(`repos/${input.repoKey}/issues/comments/${input.commentId}`),
    confirms: (input, observation) =>
      !!observation && typeof observation === 'object' && (observation as { body?: unknown }).body === input.body,
  },
}

const issueCloseSpec: GithubWriteSpec<IssueCloseInput, unknown> = {
  id: 'issue-close',
  keys: (input) => issueKeys(input.repoKey, input.number),
  priority: 'critical',
  deadlineMs: 30_000,
  maxPages: 2,
  // Closing an already-closed issue converges on the same terminal state.
  repeatable: true,
  dispatch: (reader, input) =>
    reader.mutate(`repos/${input.repoKey}/issues/${input.number}`, 'PATCH', { state: 'closed' }),
  readback: {
    run: (reader, input) => reader.json<{ state?: string }>(`repos/${input.repoKey}/issues/${input.number}`),
    confirms: (_input, observation) =>
      String((observation as { state?: unknown } | null)?.state ?? '').toUpperCase() === 'CLOSED',
  },
}

const prMergeSpec: GithubWriteSpec<PrMergeInput, { merged?: boolean }> = {
  id: 'pr-merge',
  keys: (input) => [`${input.repoKey}/pulls/${input.number}`, `repo:${input.repoKey}`],
  priority: 'critical',
  deadlineMs: 120_000,
  maxPages: 2,
  // The head SHA is a compare-and-swap: re-dispatching the same head either
  // merges it or reports it already merged — never a second merge.
  repeatable: true,
  dispatch: (reader, input) =>
    reader.mutate<{ merged?: boolean }>(`repos/${input.repoKey}/pulls/${input.number}/merge`, 'PUT', {
      merge_method: 'merge',
      commit_message: `Closes #${input.issueNumber}`,
      sha: input.headRefOid,
    }),
  readback: {
    run: (reader, input) =>
      reader.json<{ merged_at?: string; head?: { sha?: string } | null }>(
        `repos/${input.repoKey}/pulls/${input.number}`,
      ),
    // Version-bound (review CF2): merged_at alone would confirm a DIFFERENT
    // head's merge — the readback must see the exact CAS'd head merged.
    confirms: (input, observation) => {
      const pr = observation as { merged_at?: unknown; head?: { sha?: unknown } | null } | null
      return pr?.merged_at != null && String(pr.head?.sha ?? '') === input.headRefOid
    },
  },
}

interface ApprovalInput {
  repoKey: string
  prNumber: number
  body: string
  /** The reviewed commit identity the approval is bound to (review CF2). */
  reviewedHead: string
}

/** The reviewed short hash must be a prefix of the review's full commit_id —
 *  the approval confirms the commit the review covered, never another head. */
const bindsReviewedCommit = (commitId: string | null | undefined, reviewedHead: string): boolean => {
  const full = String(commitId ?? '')
    .trim()
    .toLowerCase()
  const short = reviewedHead.trim().toLowerCase()
  return short.length >= 4 && full.startsWith(short)
}

const approvalSpec: GithubWriteSpec<ApprovalInput, { id: number }> = {
  id: 'pr-review-approve',
  keys: (input) => [`${input.repoKey}/pulls/${input.prNumber}`, `repo:${input.repoKey}`],
  priority: 'normal',
  deadlineMs: 30_000,
  maxPages: 2,
  // Approving twice accumulates two APPROVED reviews on the PR — the write
  // is non-repeatable, so callers persist the attempt marker first.
  repeatable: false,
  dispatch: (reader, input) =>
    reader.mutate<{ id: number }>(`repos/${input.repoKey}/pulls/${input.prNumber}/reviews`, 'POST', {
      event: 'APPROVE',
      body: input.body,
    }),
  readback: {
    // Paginated: PRs accumulate reviews beyond one default page. The viewer
    // login pins the authenticated actor: an APPROVED entry by someone else
    // with the same body must not confirm OUR approval (review CF2).
    run: async (reader, input) => {
      const [reviews, viewer] = await Promise.all([
        reader.paginate<{ state?: string; body?: string; commit_id?: string; user?: { login?: string } | null }>(
          `repos/${input.repoKey}/pulls/${input.prNumber}/reviews`,
        ),
        reader.json<{ login?: string }>('user'),
      ])
      return { reviews, viewerLogin: viewer?.login ?? null }
    },
    confirms: (input, observation) => {
      const result = observation as {
        reviews?: Array<{ state?: string; body?: string; commit_id?: string; user?: { login?: string } | null }>
      } | null
      if (!result || !Array.isArray(result.reviews)) return false
      const viewerLogin = (observation as { viewerLogin?: string | null } | null)?.viewerLogin
      if (!viewerLogin) return false
      return result.reviews.some(
        (entry) =>
          String(entry.state ?? '').toUpperCase() === 'APPROVED' &&
          entry.body === input.body &&
          bindsReviewedCommit(entry.commit_id, input.reviewedHead) &&
          entry.user?.login === viewerLogin,
      )
    },
  },
}

/** Issue body rewrite: setting the full body converges on the same content,
 *  so a re-dispatch is safe without a durable marker. */
const issueUpdateSpec: GithubWriteSpec<IssueUpdateInput, { updated_at?: string }> = {
  id: 'issue-update',
  keys: (input) => issueKeys(input.repoKey, input.number),
  priority: 'normal',
  deadlineMs: 30_000,
  maxPages: 2,
  repeatable: true,
  dispatch: (reader, input) =>
    reader.mutate<{ updated_at?: string }>(`repos/${input.repoKey}/issues/${input.number}`, 'PATCH', {
      body: input.body,
    }),
  readback: {
    run: (reader, input) => reader.json<{ body?: string }>(`repos/${input.repoKey}/issues/${input.number}`),
    confirms: (input, observation) =>
      !!observation && typeof observation === 'object' && (observation as { body?: unknown }).body === input.body,
  },
}

/** Dependency-unlock comment: convergent — the dispatch itself re-checks for
 *  the marker text under the resource lease (check-then-write inside the
 *  serialized section, not before it) and skips the POST when one already
 *  exists, so a re-dispatch converges instead of duplicating. */
const dependencyUnlockCommentSpec: GithubWriteSpec<DependencyUnlockCommentInput, { id: number; posted: boolean }> = {
  id: 'dependency-unlock-comment',
  keys: (input) => issueKeys(input.repoKey, input.number),
  priority: 'normal',
  deadlineMs: 30_000,
  // The page budget is shared by the whole logical request: up to two pages
  // for the marker scan plus two for the authoritative readback.
  maxPages: 4,
  repeatable: true,
  dispatch: async (reader, input) => {
    // The marker scan is paginated: a marker comment beyond the first page
    // must still be found, or the convergent skip would double-post.
    const comments = await reader.paginate<{ id?: number; body?: string | null }>(
      `repos/${input.repoKey}/issues/${input.number}/comments`,
    )
    const existing = comments.find((entry) => String(entry.body ?? '').includes(input.marker))
    if (existing) return { id: existing.id ?? 0, posted: false }
    const created = await reader.mutate<{ id: number }>(
      `repos/${input.repoKey}/issues/${input.number}/comments`,
      'POST',
      {
        body: input.body,
      },
    )
    return { id: created.id, posted: true }
  },
  readback: {
    run: (reader, input) =>
      reader.paginate<{ body?: string | null }>(`repos/${input.repoKey}/issues/${input.number}/comments`),
    confirms: (input, observation) =>
      Array.isArray(observation) && observation.some((entry) => String(entry.body ?? '').includes(input.marker)),
  },
}

/** PR creation is non-repeatable: re-dispatching forks a duplicate PR, so the
 *  caller persists an attempt marker first; restart recovery re-reads the
 *  open-PR-by-head list and never re-creates. */
const prCreateSpec: GithubWriteSpec<PrCreateInput, { number?: number }> = {
  id: 'pr-create',
  keys: (input) => [`repo:${input.repoKey}`, `${input.repoKey}/pulls/head/${input.branch}`],
  priority: 'normal',
  deadlineMs: 60_000,
  maxPages: 2,
  repeatable: false,
  dispatch: (reader, input) =>
    reader.mutate<{ number?: number }>(`repos/${input.repoKey}/pulls`, 'POST', {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body,
    }),
  readback: {
    run: (reader, input) =>
      reader.json<Array<{ number?: number; head?: { ref?: string } | null }>>(
        `repos/${input.repoKey}/pulls?state=open&head=${encodeURIComponent(
          `${input.repoKey.split('/')[0]}:${input.branch}`,
        )}&per_page=1`,
      ),
    confirms: (input, observation) =>
      Array.isArray(observation) &&
      observation.some((entry) => entry.number !== undefined && entry.head?.ref === input.branch),
  },
}

/** Families migrate slice by slice; unregistered ids are a configuration
 *  error at submit time (githubWrite throws). */
export const GITHUB_WRITE_OPERATIONS: Partial<Record<GithubWriteOperationId, GithubWriteSpec<never, never>>> = {
  'issue-comment-create': commentCreateSpec as unknown as GithubWriteSpec<never, never>,
  'comment-edit': commentEditSpec as unknown as GithubWriteSpec<never, never>,
  'issue-close': issueCloseSpec as unknown as GithubWriteSpec<never, never>,
  'issue-update': issueUpdateSpec as unknown as GithubWriteSpec<never, never>,
  'dependency-unlock-comment': dependencyUnlockCommentSpec as unknown as GithubWriteSpec<never, never>,
  'pr-merge': prMergeSpec as unknown as GithubWriteSpec<never, never>,
  'pr-review-approve': approvalSpec as unknown as GithubWriteSpec<never, never>,
  'pr-create': prCreateSpec as unknown as GithubWriteSpec<never, never>,
}

/** Human-readable error text for a non-confirmed write outcome. */
export function githubWriteOutcomeError(outcome: { outcome: string; error?: unknown }): string {
  const text =
    outcome.error instanceof Error ? outcome.error.message : outcome.error === undefined ? '' : String(outcome.error)
  return text || `outcome=${outcome.outcome}`
}

/** Submit one typed write through the ctx-bound reader (family migrations). */
export async function githubWrite<TInput, TDispatch>(
  ctx: Context,
  intent: {
    operation: GithubWriteOperationId
    input: TInput
    persistMarker?: () => Promise<void>
  },
): Promise<GithubWriteOutcome<TDispatch>> {
  const spec = GITHUB_WRITE_OPERATIONS[intent.operation] as GithubWriteSpec<TInput, TDispatch> | undefined
  if (!spec) throw new Error(`未声明的 GitHub 写操作: ${intent.operation}`)
  const { githubRest } = await import('./rest.ts')
  const reader = githubRest(ctx)
  const owner = reader.boundOwner()
  return runWriteTransaction(owner, reader, spec, intent.input, { persistMarker: intent.persistMarker })
}

/** Restart recovery for a family whose attempt marker survived: readback
 *  ONLY, zero write dispatch (ADR-0010 §9). Callers invoke this when their
 *  durable action state still carries a pending marker. */
export async function githubWriteRecoverOperation<TInput, TDispatch>(
  ctx: Context,
  intent: { operation: GithubWriteOperationId; input: TInput },
): Promise<GithubWriteOutcome<TDispatch>> {
  const spec = GITHUB_WRITE_OPERATIONS[intent.operation] as GithubWriteSpec<TInput, TDispatch> | undefined
  if (!spec) throw new Error(`未声明的 GitHub 写操作: ${intent.operation}`)
  const { githubRest } = await import('./rest.ts')
  const reader = githubRest(ctx)
  return githubWriteRecover(reader.boundOwner(), reader, spec, intent.input)
}
