/**
 * Shared entry points for Controller-owned remote Git operations (issue #135
 * slice A). Thin, zero-behavior extraction: the command strings, timeouts and
 * sandbox policies match the call sites verbatim, and non-zero exits keep the
 * shared runCommand semantics. The Remote Git Coordinator (slice B) will own
 * these entry points — singleflight, the per-repository critical section, the
 * authoritative post-push readback and the snapshot invalidation broadcast
 * all wrap here, so no call site can bypass them.
 */

import type { Context } from '@deepseek-ai/cordis'
import { runCommand } from './runtime.ts'

export interface RemoteGitCommandOptions {
  workdir: string
  timeoutMs?: number
  sandboxPolicy?: {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    workspaceRoot: string
  }
}

/** `git fetch origin [--prune]` — mutates local remote-tracking refs. */
export function remoteFetch(ctx: Context, options: RemoteGitCommandOptions & { prune?: boolean }): Promise<string> {
  const { prune = true, ...command } = options
  return runCommand(ctx, prune ? 'git fetch origin --prune' : 'git fetch origin', command)
}

/** `git push [--set-upstream] origin <refspec>` — mutates the remote. */
export function remotePush(
  ctx: Context,
  options: RemoteGitCommandOptions & { refspec: string; setUpstream?: boolean },
): Promise<string> {
  const { refspec, setUpstream = false, ...command } = options
  return runCommand(ctx, `git push ${setUpstream ? '--set-upstream ' : ''}origin ${refspec}`, command)
}
