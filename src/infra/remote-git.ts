/** Controller-owned Remote Git entry points governed by ADR-0011. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  createRemoteGitCoordinator,
  type RemoteGitCoordinator,
  type RemoteGitFreshness,
  type RemoteGitWriteAttempt,
} from './remote-git-coordinator.ts'
import type { RemoteGitDeletePreparation } from './remote-git-delete.ts'
import { createRemoteGitEvidenceSink } from './remote-git-evidence.ts'
import { notifyLocalGitMutation } from './local-git-invalidate.ts'
import { runCommand } from './runtime.ts'

export interface RemoteGitCommandOptions {
  /**
   * Stable coordination identity (grill Q1): the configured repoKey today.
   * The Coordinator (slice B) keys singleflight and the per-(repoKey, remote)
   * critical section on this value — never on a worktree path.
   */
  repoKey: string
  /**
   * Placeholder for ProjectBinding.repositoryId (grill Q1): carried but not
   * consumed until project bindings are complete, so the later switch is a
   * value change, not a signature change.
   */
  repositoryId?: string | null
  /** Remote name (grill Q3 scope); defaults to 'origin'. */
  remote?: string
  workdir: string
  timeoutMs?: number
  sandboxPolicy?: {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    workspaceRoot: string
  }
}

let processCoordinator: RemoteGitCoordinator | null = null

export function remoteGitCoordinator(): RemoteGitCoordinator {
  if (processCoordinator) return processCoordinator
  processCoordinator = createRemoteGitCoordinator({ sink: createRemoteGitEvidenceSink() })
  return processCoordinator
}

export async function closeRemoteGitCoordinator(): Promise<void> {
  const coordinator = processCoordinator
  processCoordinator = null
  await coordinator?.close()
}

export function resetRemoteGitCoordinatorForTests(): void {
  processCoordinator = null
}

function normalizedRemote(remote: string | undefined): string {
  const value = remote ?? 'origin'
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('@{')
  ) {
    throw new Error(`非法 Git remote 名称: ${value}`)
  }
  return value
}

function outcomeError(action: string, outcome: { outcome: string; error?: string }): Error {
  return new Error(`${action} 未确认(${outcome.outcome}): ${outcome.error ?? 'unknown'}`)
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function assertOid(value: string | null, label: string): void {
  if (value !== null && !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} 必须是完整 40 位 Git OID`)
}

function assertDestinationRef(value: string): void {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.includes('@{')) {
    throw new Error(`非法远端目标 ref: ${value}`)
  }
}

async function readRemoteHead(
  ctx: Context,
  remote: string,
  destinationRef: string,
  options: RemoteGitCommandOptions,
): Promise<string | null> {
  const output = await runCommand(ctx, `git ls-remote --heads ${remote} ${quoted(destinationRef)}`, {
    workdir: options.workdir,
    timeoutMs: 30_000,
    sandboxPolicy: options.sandboxPolicy,
  })
  return output.trim().split(/\s+/)[0] || null
}

export interface RemotePushPreparation {
  operationKind: RemoteGitWriteAttempt['operationKind']
  destinationRef: string
  expectedOid: string | null
  expectedRemoteOid: string | null
}

/** `git fetch <remote> [--prune]` — mutates local remote-tracking refs. */
export async function remoteFetch(
  ctx: Context,
  options: RemoteGitCommandOptions & { prune?: boolean },
): Promise<string> {
  const { prune = true } = options
  const remote = normalizedRemote(options.remote)
  const outcome = await remoteGitCoordinator().fetch({
    scope: { repoKey: options.repoKey, repositoryId: options.repositoryId, remote },
    prune,
    execute: () =>
      runCommand(ctx, prune ? `git fetch ${remote} --prune` : `git fetch ${remote}`, {
        workdir: options.workdir,
        timeoutMs: options.timeoutMs ?? 60_000,
        sandboxPolicy: options.sandboxPolicy,
      }),
    invalidate: () => notifyLocalGitMutation({ repoKey: options.repoKey }, 'remote-fetch', 'RemoteGitCoordinator'),
    readback: () =>
      runCommand(ctx, `git for-each-ref --format='%(refname) %(objectname)' refs/remotes/${remote}`, {
        workdir: options.workdir,
        timeoutMs: 10_000,
        sandboxPolicy: options.sandboxPolicy,
      }),
  })
  if (outcome.outcome !== 'confirmed') throw outcomeError('git fetch', outcome)
  return outcome.output ?? ''
}

export async function remoteLsRemote(
  ctx: Context,
  options: RemoteGitCommandOptions & { query: string; heads?: boolean },
): Promise<string> {
  const remote = normalizedRemote(options.remote)
  const query = options.query.trim()
  if (!query || /[\r\n\0]/.test(query)) throw new Error('非法 ls-remote query')
  const outcome = await remoteGitCoordinator().lsRemote({
    scope: { repoKey: options.repoKey, repositoryId: options.repositoryId, remote },
    query: `${options.heads ? 'heads:' : ''}${query}`,
    execute: () =>
      runCommand(ctx, `git ls-remote ${options.heads ? '--heads ' : ''}${remote} '${query.replaceAll("'", "'\\''")}'`, {
        workdir: options.workdir,
        timeoutMs: options.timeoutMs ?? 30_000,
        sandboxPolicy: options.sandboxPolicy,
      }),
  })
  if (outcome.outcome !== 'confirmed') throw outcomeError('git ls-remote', outcome)
  return outcome.output ?? ''
}

export function ensureRemoteFresh(input: {
  repoKey: string
  repositoryId?: string | null
  remote?: string
  ttlMs: number
  waitMs?: number
  force?: boolean
  refresh(): Promise<void>
}): Promise<RemoteGitFreshness> {
  const remote = normalizedRemote(input.remote)
  return remoteGitCoordinator().ensureFresh({
    scope: { repoKey: input.repoKey, repositoryId: input.repositoryId, remote },
    ttlMs: input.ttlMs,
    waitMs: input.waitMs,
    force: input.force,
    refresh: input.refresh,
  })
}

/** `git push [--set-upstream] <remote> <refspec>` — mutates the remote. */
export function remotePush(
  ctx: Context,
  options: RemoteGitCommandOptions & {
    prepare(): Promise<RemotePushPreparation>
    persistAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  },
): Promise<string> {
  const remote = normalizedRemote(options.remote)
  return remoteGitCoordinator()
    .push({
      scope: { repoKey: options.repoKey, repositoryId: options.repositoryId, remote },
      validate: async () => {
        const plan = await options.prepare()
        assertDestinationRef(plan.destinationRef)
        assertOid(plan.expectedOid, 'expectedOid')
        assertOid(plan.expectedRemoteOid, 'expectedRemoteOid')
        if (plan.operationKind === 'delete' && plan.expectedOid !== null) {
          throw new Error('delete push 的 expectedOid 必须为 null')
        }
        if (plan.operationKind !== 'delete' && plan.expectedOid === null) {
          throw new Error('非 delete push 必须冻结 expectedOid')
        }
        return {
          attemptId: randomUUID(),
          scope: { repoKey: options.repoKey, repositoryId: options.repositoryId, remote },
          ...plan,
          status: 'prepared' as const,
          preparedAt: new Date().toISOString(),
        }
      },
      persistAttempt: options.persistAttempt,
      execute: (attempt) => {
        const source = attempt.expectedOid ?? ''
        const lease =
          attempt.operationKind === 'force-with-lease' || attempt.operationKind === 'delete'
            ? `--force-with-lease=${quoted(`${attempt.destinationRef}:${attempt.expectedRemoteOid ?? ''}`)} `
            : ''
        return runCommand(ctx, `git push ${lease}${remote} ${quoted(`${source}:${attempt.destinationRef}`)}`, {
          workdir: options.workdir,
          timeoutMs: options.timeoutMs ?? 120_000,
          sandboxPolicy: options.sandboxPolicy,
        })
      },
      invalidate: () => notifyLocalGitMutation({ repoKey: options.repoKey }, 'remote-push', 'RemoteGitCoordinator'),
      readback: (attempt) => readRemoteHead(ctx, remote, attempt.destinationRef, options),
      settleAttempt: options.settleAttempt,
    })
    .then((outcome) => {
      if (outcome.outcome !== 'confirmed') throw outcomeError('git push', outcome)
      return outcome.output ?? ''
    })
}

export async function remoteDeleteBranchIfPresent(
  ctx: Context,
  options: RemoteGitCommandOptions & {
    prepare(): Promise<RemoteGitDeletePreparation>
    persistAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  },
): Promise<string> {
  const remote = normalizedRemote(options.remote)
  const outcome = await remoteGitCoordinator().deleteRemoteBranchIfPresent({
    scope: { repoKey: options.repoKey, repositoryId: options.repositoryId, remote },
    validate: async () => {
      const plan = await options.prepare()
      assertDestinationRef(plan.destinationRef)
      assertOid(plan.expectedRemoteOid, 'expectedRemoteOid')
      return plan
    },
    preRead: (plan) => readRemoteHead(ctx, remote, plan.destinationRef, options),
    persistAttempt: options.persistAttempt,
    execute: (attempt) =>
      runCommand(
        ctx,
        `git push --force-with-lease=${quoted(`${attempt.destinationRef}:${attempt.expectedRemoteOid}`)} ${remote} ${quoted(`:${attempt.destinationRef}`)}`,
        {
          workdir: options.workdir,
          timeoutMs: options.timeoutMs ?? 120_000,
          sandboxPolicy: options.sandboxPolicy,
        },
      ),
    invalidate: () => notifyLocalGitMutation({ repoKey: options.repoKey }, 'remote-delete', 'RemoteGitCoordinator'),
    readback: (attempt) => readRemoteHead(ctx, remote, attempt.destinationRef, options),
    settleAttempt: options.settleAttempt,
  })
  if (outcome.outcome !== 'confirmed') throw outcomeError('git push --delete', outcome)
  return outcome.output ?? ''
}

export async function recoverRemotePush(
  ctx: Context,
  options: RemoteGitCommandOptions & {
    attempt: RemoteGitWriteAttempt
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  },
): Promise<void> {
  const remote = normalizedRemote(options.remote ?? options.attempt.scope.remote)
  const outcome = await remoteGitCoordinator().recoverPush({
    attempt: options.attempt,
    readback: (attempt) => readRemoteHead(ctx, remote, attempt.destinationRef, options),
    settleAttempt: options.settleAttempt,
  })
  if (outcome.outcome !== 'confirmed') throw outcomeError('git push recovery', outcome)
}
