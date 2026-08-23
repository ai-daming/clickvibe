/** ClickVibe host composition root. */
/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/command`        — text-command entry (issue #13): conversation
 *                                      triggers reuse the same action handlers below
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/history`        — complete disk-backed task history
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { fetchIssue } from '../github/issue.ts'
import {
  type AgentAuthorization,
  isLoopbackAddress,
  parseAgent,
} from '../infra/develop-core.ts'
import {
  consumeAuthorization,
  githubAwareStatus,
  privilegedRequestError,
} from '../infra/runtime.ts'
import { startDevelop } from './develop-start.ts'
import { handleCommand, listProjects, stateWorkflows } from './handlers.ts'
import { authorizeAgent, mergeAndCleanup } from './merge.ts'
import { fetchRepositoryIssues } from './repository-issues.ts'
import { resumeDevelop } from './resume.ts'
import { startReview } from './review-flow.ts'
import { syncWorktree } from './sync.ts'
import { pollDevelop, stopTask } from './task-api.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
    shell: {
      resolve(request: {
        command: string
        timeoutMs?: number
        workdir?: string
        stdin?: string
        sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
      }): unknown
      run(spec: unknown): Promise<{
        exitCode: number | null
        stdout: { text: string }
        stderr?: { text?: string }
      }>
      start(spec: unknown): {
        status: string
        exitCode: number | null
        readonly done: Promise<void>
        readOutput(): { delta: string; lossy: boolean }
        kill(): boolean
      }
    }
  }
}

/** Prefix route owning every /clickvibe/api/<method> request. */
export const ROUTE = '/clickvibe/api'

/** Body size bound of one JSON request. */
export async function handleApiPost(
  ctx: Context,
  req: IncomingMessage,
  method: string | undefined,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  if (method === 'command') return await handleCommand(ctx, req, payload)
  if (method === 'fetch') {
    const result = await fetchIssue(ctx, payload)
    return { status: githubAwareStatus(result), body: result }
  }
  if (method === 'projects') {
    return { status: 200, body: await listProjects() }
  }
  if (method === 'repo/issues') {
    const result = await fetchRepositoryIssues(ctx, payload)
    return { status: githubAwareStatus(result), body: result }
  }
  if (method === 'state')
    return await stateWorkflows(
      ctx,
      payload as { url?: unknown; repoKey?: unknown; forceRefresh?: unknown } | undefined,
    )
  if (method === 'authorize') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    const result = await authorizeAgent(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'develop') {
    let authorization: AgentAuthorization | null = null
    try {
      const requestedAgent = parseAgent((payload as { agent?: unknown } | undefined)?.agent)
      if (requestedAgent === 'dryrun') {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          return { status: 403, body: { ok: false, error: 'dryrun 仅允许本机回环地址触发' } }
        }
      } else {
        const securityError = privilegedRequestError(req)
        if (securityError) return { status: 403, body: { ok: false, error: securityError } }
        authorization = consumeAuthorization('develop', payload)
        if (!authorization) {
          return { status: 403, body: { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新预览确认' } }
        }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
    const result = await startDevelop(ctx, payload, authorization?.snapshot ?? null)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'develop/poll') {
    const result = await pollDevelop(payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'review') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    try {
      if (!consumeAuthorization('review', payload)) {
        return { status: 403, body: { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新确认' } }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
    const result = await startReview(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'resume') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    try {
      if (!consumeAuthorization('resume', payload)) {
        return { status: 403, body: { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新确认' } }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
    const result = await resumeDevelop(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'stop') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    const result = stopTask(payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'sync') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    const result = await syncWorktree(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'merge') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    try {
      if (!consumeAuthorization('merge', payload)) {
        return { status: 403, body: { ok: false, error: '合并授权无效、已使用或已过期,请重新预览确认' } }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
    const result = await mergeAndCleanup(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  return { status: 404, body: { ok: false, error: `unknown method "${method}"` } }
}
