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
import { closeGithubGateway } from './github/gateway-owner.ts'
import { closeRemoteGitCoordinator } from './infra/remote-git.ts'
import { loadEmbeddedGhIssueSkill } from './infra/embedded-skill.ts'
import { ROUTE } from './infra/http-contract.ts'
import { readJsonBody, writeJson } from './infra/runtime.ts'
import { handleApiPost } from './workflow/dispatch.ts'
import { getTaskHistory, handleStream } from './workflow/task-api.ts'

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
        readOutput(): {
          delta: string
          lossy: boolean
          stdoutSpillPath?: string
          stderrSpillPath?: string
        }
        kill(): boolean
      }
    }
    skills: {
      register(skill: { name: string; description: string; source: string; content: string }): () => void
    }
  }
}

export { ROUTE } from './infra/http-contract.ts'
export {
  createOfflineV02GenerationFence,
  createOnlineV02GenerationFence,
  V02_OFFLINE_HOST_DECLARATION,
} from './infra/v02-generation-fence.ts'
export { applyV02Upgrade } from './infra/v02-upgrade-execution.ts'
export { previewV02UpgradeRecovery, resumeV02Upgrade, rollbackV02Upgrade } from './infra/v02-upgrade-recovery.ts'
export { previewV02Upgrade, v02UpgradePlanFingerprint } from './infra/v02-upgrade.ts'

export const name = 'clickvibe'

export const inject = ['webServer', 'shell', 'skills', 'jobs']

export function apply(ctx: Context): void {
  ctx.jobs?.attachController('clickvibe')
  ctx.skills.register(loadEmbeddedGhIssueSkill())
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://clickvibe.internal').pathname
      const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(`${ROUTE}/`.length) : undefined
      const knownMethods = new Set([
        'fetch',
        'projects',
        'repo/issues',
        'state',
        'authorize',
        'auto',
        'develop',
        'develop/poll',
        'history',
        'stream',
        'review',
        'create-pr',
        'resume',
        'stop',
        'sync',
        'merge',
        'command',
      ])
      if (method === undefined || !knownMethods.has(method)) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }

      // SSE stream endpoint (GET)
      if (method === 'stream') {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'stream requires GET' })
          return
        }
        handleStream(req, res)
        return
      }

      if (method === 'history') {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'history requires GET' })
          return
        }
        const result = await getTaskHistory(req)
        writeJson(res, result.ok ? 200 : 404, result)
        return
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      // JSON POST endpoints
      let payload: unknown
      try {
        payload = await readJsonBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        return
      }

      const { status, body } = await handleApiPost(ctx, req, method, payload)
      writeJson(res, status, body)
    },
  })
  // Gateway lifecycle follows the plugin fiber: on unload, admission closes,
  // queued steps interrupt, running steps drain and lifecycle evidence
  // flushes (ADR-0010 §10); nothing crosses into the next credential
  // generation. cordis effects await their disposer during teardown.
  ctx.effect(() => closeGithubGateway, 'clickvibe: close the GitHub gateway')
  ctx.effect(() => closeRemoteGitCoordinator, 'clickvibe: close the Remote Git Coordinator')
}

export { buildMergePreface } from './infra/git.ts'
export { deriveWorkflowState } from './workflow/derive.ts'
export { assertReviewHeadMatchesPr, isSyncEquivalentMerge } from './workflow/merge-gates.ts'
export { fetchRepositoryIssues } from './workflow/repository-issues.ts'
export { enrichWorkflowStates } from './workflow/repository-state.ts'
export { resumeDevelop } from './workflow/resume.ts'
export { syncWorktree } from './workflow/sync.ts'
