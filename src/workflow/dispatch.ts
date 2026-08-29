/** Thin HTTP method dispatcher for workflow use cases. */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { localGitSnapshots } from '../infra/local-git-snapshot.ts'
import { fetchIssue } from '../github/issue.ts'
import { type AgentAuthorization, isLoopbackAddress, parseAgent } from '../infra/develop-core.ts'
import { consumeAuthorization, githubAwareStatus, privilegedRequestError } from '../infra/runtime.ts'
import { startDevelop } from './develop-start.ts'
import { createPullRequest } from './create-pr.ts'
import { startAutoRun } from './auto-run.ts'
import { handleCommand, listProjects, stateWorkflows } from './handlers.ts'
import { authorizeAgent, mergeAndCleanup } from './merge.ts'
import { fetchRepositoryIssues } from './repository-issues.ts'
import { syncConfiguredRepository } from './repository-sync.ts'
import { resumeDevelop } from './resume.ts'
import { startReview } from './review-flow.ts'
import { syncWorktree } from './sync.ts'
import { restoreBaseBranch } from './baseline-restore.ts'
import { pollDevelop, stopTask } from './task-api.ts'

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
    const result = await fetchRepositoryIssues(ctx, payload, { observation: localGitSnapshots })
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
  if (method === 'auto') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    try {
      const authorization = consumeAuthorization('auto', payload)
      if (!authorization) {
        return { status: 403, body: { ok: false, error: '自动跑到底授权无效、已使用或已过期,请重新确认' } }
      }
      const result = await startAutoRun(ctx, payload, authorization.snapshot)
      return { status: result.ok ? 200 : 400, body: result }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
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
  if (method === 'create-pr') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    try {
      if (!consumeAuthorization('create-pr', payload)) {
        return { status: 403, body: { ok: false, error: '创建 PR 授权无效、已使用或已过期,请重新确认' } }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
    }
    const result = await createPullRequest(ctx, payload)
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
    const result = await stopTask(ctx, payload)
    return { status: result.ok ? 200 : 400, body: result }
  }
  if (method === 'sync') {
    const securityError = privilegedRequestError(req)
    if (securityError) return { status: 403, body: { ok: false, error: securityError } }
    if ((payload as { restoreBase?: unknown } | undefined)?.restoreBase === true) {
      try {
        if (!consumeAuthorization('restore-base', payload)) {
          return { status: 403, body: { ok: false, error: '恢复基线授权无效、已使用或已过期,请重新确认' } }
        }
      } catch (error) {
        return { status: 400, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
      }
      const result = await restoreBaseBranch(ctx, payload)
      return { status: result.ok ? 200 : 400, body: result }
    }
    const repoKey = String((payload as { repoKey?: unknown } | undefined)?.repoKey ?? '').trim()
    const result = repoKey ? await syncConfiguredRepository(ctx, payload) : await syncWorktree(ctx, payload)
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
