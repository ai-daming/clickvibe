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
import type { GithubGatewayOwner } from './gateway-contracts.ts'
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
 *  restart recovery: readback ONLY, zero write dispatch). */
export async function githubWriteRecover<TInput, TDispatch>(
  owner: GithubGatewayOwner,
  reader: GithubRestReader,
  spec: GithubWriteSpec<TInput, TDispatch>,
  input: TInput,
): Promise<GithubWriteOutcome<TDispatch>> {
  const requestId = owner.declareLogicalRequest('write', `${spec.id}:recover`)
  try {
    const observation = await owner.runWithRequest(requestId, () =>
      owner.runWithLeaseExemption(() => spec.readback.run(reader, input)),
    )
    const confirmed = spec.readback.confirms(input, observation)
    owner.noteReadbackSettled(requestId, confirmed)
    owner.noteTerminal(requestId, confirmed ? 'succeeded' : 'unknown', confirmed ? undefined : '回读未证实预期事实')
    return confirmed
      ? ({ outcome: 'confirmed', value: undefined as TDispatch } as { outcome: 'confirmed'; value: TDispatch })
      : { outcome: 'unknown', error: new Error('回读未证实预期事实') }
  } catch (error) {
    owner.noteReadbackSettled(requestId, false)
    owner.noteTerminal(requestId, 'unknown', errorText(error))
    return { outcome: 'unknown', error }
  }
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
  const release = await owner.acquireWriteLeases(leaseKeys)
  const requestId = owner.declareLogicalRequest('write', `${spec.id}:${leaseKeys[0] ?? spec.id}`)
  try {
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
      dispatched = await owner.runWithAdmission(
        { priority: spec.priority, deadlineMs: spec.deadlineMs, maxPages: spec.maxPages },
        () => owner.runWithRequest(requestId, () => spec.dispatch(reader, input)),
      )
    } catch (dispatchError) {
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
    release()
  }
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
    const observation = await owner.runWithRequest(requestId, () =>
      owner.runWithLeaseExemption(() => spec.readback.run(reader, input)),
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

/** Slice B family registry entry point — populated as call sites migrate. */
export type GithubWriteOperationId =
  | 'issue-comment-create'
  | 'comment-edit'
  | 'issue-update'
  | 'issue-close'
  | 'pr-review-approve'
  | 'pr-merge'
  | 'pr-create'

export const GITHUB_WRITE_OPERATIONS: Partial<Record<GithubWriteOperationId, GithubWriteSpec<never, never>>> = {}

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
