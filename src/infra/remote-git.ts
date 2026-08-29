/**
 * Shared entry points for Controller-owned remote Git operations (issue #135
 * slice A). Thin, zero-behavior extraction: the command strings, timeouts and
 * sandbox policies match the call sites verbatim, and non-zero exits keep the
 * shared runCommand semantics. The Remote Git Coordinator (slice B) will own
 * these entry points — singleflight, the per-repository critical section, the
 * authoritative post-push readback and the snapshot invalidation broadcast
 * all wrap here for every migrated call site (the two compound flows pending
 * in slice C still go direct).
 */

import type { Context } from '@deepseek-ai/cordis'
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

/** `git fetch <remote> [--prune]` — mutates local remote-tracking refs. */
export function remoteFetch(ctx: Context, options: RemoteGitCommandOptions & { prune?: boolean }): Promise<string> {
  const { prune = true } = options
  const remote = options.remote ?? 'origin'
  return runCommand(ctx, prune ? `git fetch ${remote} --prune` : `git fetch ${remote}`, {
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
    sandboxPolicy: options.sandboxPolicy,
  })
}

/** `git push [--set-upstream] <remote> <refspec>` — mutates the remote. */
export function remotePush(
  ctx: Context,
  options: RemoteGitCommandOptions & { refspec: string; setUpstream?: boolean },
): Promise<string> {
  const { refspec, setUpstream = false } = options
  const remote = options.remote ?? 'origin'
  return runCommand(ctx, `git push ${setUpstream ? '--set-upstream ' : ''}${remote} ${refspec}`, {
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
    sandboxPolicy: options.sandboxPolicy,
  })
}
