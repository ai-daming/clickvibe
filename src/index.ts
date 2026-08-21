/**
 * clickvibe host half: a /clickvibe/api JSON route that fetches GitHub
 * issue / PR data through the local gh CLI.
 *
 * The client bundle posts to `/clickvibe/api/fetch` with `{ url }`; this
 * route validates the URL shape, runs `gh issue view` / `gh pr view`, and
 * returns the parsed JSON envelope `{ ok, data }` / `{ ok: false, error }`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
      resolve(request: { command: string; timeoutMs?: number }): unknown
      run(spec: unknown): Promise<{
        exitCode: number | null
        stdout: { text: string }
        stderr?: { text?: string }
      }>
    }
  }
}

/** Prefix route owning every /clickvibe/api/<method> request. */
const ROUTE = '/clickvibe/api'

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 64 * 1024

/** Fields the issue fetch requests from gh (all verified against rc.8). */
const ISSUE_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'comments', 'reactionGroups', 'isPinned',
].join(',')

/** Fields the PR fetch requests from gh (all verified against rc.8). */
const PR_FIELDS = [
  'number', 'title', 'state', 'author', 'createdAt', 'updatedAt',
  'closedAt', 'mergedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'additions', 'deletions', 'changedFiles', 'commits',
  'isDraft', 'mergeable', 'mergeStateStatus', 'baseRefName',
  'headRefName', 'reviews', 'reviewRequests', 'comments',
].join(',')

/** Read the (bounded) JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        reject(new Error('malformed JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response with the given status. */
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * The clickvibe plugin: exports the profile-patch plugin contract
 * (inject / apply) the cordis loader expects.
 */
export const name = 'clickvibe'

export const inject = ['webServer', 'shell']

export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://clickvibe.internal').pathname
      const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(`${ROUTE}/`.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }

      let payload: unknown
      try {
        payload = await readJsonBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        return
      }

      if (method === 'fetch') {
        const result = await fetchIssue(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }

      writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
    },
  })
}

/** Validate the URL and run gh, returning the { ok, ... } envelope. */
async function fetchIssue(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown } } | { ok: false; error: string }> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const isPR = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)
  const isIssue = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(url)
  if (!isPR && !isIssue) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }

  const command = `${isPR ? 'gh pr view' : 'gh issue view'} ${url} --json ${isPR ? PR_FIELDS : ISSUE_FIELDS}`
  try {
    const spec = ctx.shell.resolve({ command, timeoutMs: 20000 })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) {
      const stderr = result.stderr?.text ?? ''
      return { ok: false, error: stderr || `gh 执行失败(exit ${result.exitCode})` }
    }
    const parsed = JSON.parse(result.stdout.text) as unknown
    return { ok: true, data: { kind: isPR ? 'pr' : 'issue', item: parsed } }
  } catch (error) {
    return { ok: false, error: `抓取异常: ${String(error instanceof Error ? error.message : error)}` }
  }
}
