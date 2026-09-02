/** ADR-0011 Slice C: one serialized, nullable remote-branch delete operation. */

import type { RemoteGitOutcome, RemoteGitWriteAttempt } from './remote-git-contracts.ts'
import type { RemoteGitLifecycleEvent, RemoteGitScope, RemoteGitTerminalOutcome } from './remote-git-lifecycle.ts'

export interface RemoteGitDeletePreparation {
  destinationRef: string
  expectedRemoteOid: string
}

export interface RemoteGitDeleteInput {
  scope: RemoteGitScope
  validate(): Promise<RemoteGitDeletePreparation>
  preRead(plan: RemoteGitDeletePreparation): Promise<string | null>
  persistAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  execute(attempt: RemoteGitWriteAttempt): Promise<string>
  invalidate(): void
  readback(attempt: RemoteGitWriteAttempt): Promise<string | null>
  settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
}

interface DeleteRuntime {
  assertOpen(): void
  now(): number
  newId(): string
  enqueue(
    scope: RemoteGitScope,
    requestId: string,
    flightId: string,
    run: () => Promise<RemoteGitOutcome>,
  ): Promise<RemoteGitOutcome>
  emit(event: RemoteGitLifecycleEvent): void
  noteSubprocess(
    requestId: string,
    flightId: string,
    phase: 'pre-read' | 'push' | 'readback',
    startedAt: number,
    error?: unknown,
    attemptId?: string,
  ): void
  terminal(
    requestId: string,
    flightId: string,
    outcome: RemoteGitTerminalOutcome,
    error?: unknown,
    attemptId?: string,
  ): void
  errorText(error: unknown): string
}

export async function runDeleteRemoteBranchIfPresent(
  input: RemoteGitDeleteInput,
  runtime: DeleteRuntime,
): Promise<RemoteGitOutcome> {
  runtime.assertOpen()
  const requestId = runtime.newId()
  const flightId = runtime.newId()
  const queuedAt = runtime.now()
  runtime.emit({
    kind: 'declared',
    requestId,
    scope: input.scope,
    operation: 'delete-remote-branch-if-present',
    at: runtime.now(),
  })
  const outcome = await runtime
    .enqueue(input.scope, requestId, flightId, async () => {
      let plan: RemoteGitDeletePreparation
      try {
        plan = await input.validate()
      } catch (error) {
        return { outcome: 'failed', flightId, error: runtime.errorText(error) }
      }
      runtime.emit({
        kind: 'dispatched',
        requestId,
        flightId,
        operation: 'delete-remote-branch-if-present',
        waitedMs: runtime.now() - queuedAt,
        at: runtime.now(),
      })
      let observedOid: string | null = null
      const preReadStartedAt = runtime.now()
      try {
        observedOid = await input.preRead(plan)
        runtime.noteSubprocess(requestId, flightId, 'pre-read', preReadStartedAt)
      } catch (error) {
        runtime.noteSubprocess(requestId, flightId, 'pre-read', preReadStartedAt, error)
        return { outcome: 'unknown', flightId, error: runtime.errorText(error) }
      }
      if (observedOid === null) return { outcome: 'confirmed', flightId }
      if (observedOid !== plan.expectedRemoteOid) {
        return {
          outcome: 'failed',
          flightId,
          error: `远端 ref 已变化: expected ${plan.expectedRemoteOid}, observed ${observedOid}`,
        }
      }

      const attempt: RemoteGitWriteAttempt = {
        attemptId: runtime.newId(),
        scope: input.scope,
        operationKind: 'delete',
        destinationRef: plan.destinationRef,
        expectedOid: null,
        expectedRemoteOid: observedOid,
        status: 'prepared',
        preparedAt: new Date(runtime.now()).toISOString(),
      }
      try {
        await input.persistAttempt(attempt)
      } catch (error) {
        return { outcome: 'failed', flightId, attemptId: attempt.attemptId, error: runtime.errorText(error) }
      }

      let output: string | undefined
      let commandError: unknown
      const pushStartedAt = runtime.now()
      try {
        output = await input.execute(attempt)
      } catch (error) {
        commandError = error
      }
      runtime.noteSubprocess(requestId, flightId, 'push', pushStartedAt, commandError, attempt.attemptId)
      input.invalidate()
      runtime.emit({
        kind: 'invalidated',
        requestId,
        flightId,
        attemptId: attempt.attemptId,
        repoKey: input.scope.repoKey,
        at: runtime.now(),
      })

      let readback: string | null = null
      let readbackError: unknown
      const readbackStartedAt = runtime.now()
      try {
        readback = await input.readback(attempt)
      } catch (error) {
        readbackError = error
      }
      runtime.noteSubprocess(requestId, flightId, 'readback', readbackStartedAt, readbackError, attempt.attemptId)
      const confirmed = readbackError === undefined && readback === null
      runtime.emit({
        kind: 'readback-settled',
        requestId,
        flightId,
        attemptId: attempt.attemptId,
        confirmed,
        at: runtime.now(),
      })
      const settled: RemoteGitWriteAttempt = {
        ...attempt,
        status: confirmed ? 'confirmed' : 'unknown',
        ...(confirmed
          ? {}
          : {
              diagnosticRef: runtime.errorText(readbackError ?? commandError ?? `readback=${readback ?? '<missing>'}`),
            }),
      }
      try {
        await input.settleAttempt(settled)
      } catch (error) {
        return {
          outcome: 'unknown',
          flightId,
          attemptId: attempt.attemptId,
          output,
          readback: readback ?? undefined,
          error: runtime.errorText(error),
        }
      }
      return {
        outcome: confirmed ? 'confirmed' : 'unknown',
        flightId,
        attemptId: attempt.attemptId,
        output,
        readback: readback ?? undefined,
        ...(confirmed ? {} : { error: settled.diagnosticRef }),
      }
    })
    .catch((error): RemoteGitOutcome => ({ outcome: 'unknown', flightId, error: runtime.errorText(error) }))
  runtime.terminal(requestId, flightId, outcome.outcome, outcome.error, outcome.attemptId)
  return outcome
}
