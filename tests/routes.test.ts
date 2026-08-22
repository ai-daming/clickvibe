import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, fetchRepositoryIssues } from '../src/index.ts'
import {
  appendLog,
  issueBodyHash,
  loadAllArchivedWorkflows,
  loadWorkflow,
  readLogHistory,
  saveWorkflow,
  type IssueWorkflow,
} from '../src/state.ts'

function included(body: unknown, status = 200, headers: Record<string, string> = {}): string {
  return [
    `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    JSON.stringify(body),
  ].join('\n')
}

function restIssue(item: Record<string, unknown>): Record<string, unknown> {
  const url = String(item.url ?? item.html_url ?? '')
  const number = Number(item.number ?? url.match(/\/(?:issues|pull)\/(\d+)/)?.[1] ?? 0)
  return {
    ...item,
    number,
    html_url: url,
    url: undefined,
    state: String(item.state ?? 'open').toLowerCase(),
    user: item.author ?? item.user ?? { login: 'owner' },
    created_at: item.createdAt ?? item.created_at ?? '',
    updated_at: item.updatedAt ?? item.updated_at ?? '',
    closed_at: item.closedAt ?? item.closed_at ?? null,
  }
}

function restComment(comment: Record<string, unknown>): Record<string, unknown> {
  return {
    user: comment.author ?? comment.user ?? { login: 'unknown' },
    body: comment.body ?? '',
    created_at: comment.createdAt ?? comment.created_at ?? '',
    updated_at: comment.updatedAt ?? comment.updated_at ?? '',
  }
}

function githubApi(
  command: string,
  options: {
    item?: Record<string, unknown>
    issues?: Array<Record<string, unknown>>
    pulls?: Array<Record<string, unknown>>
    pr?: Record<string, unknown>
    prComments?: Array<Record<string, unknown>>
    reviews?: Array<Record<string, unknown>>
    failRepoIssues?: string
  } = {},
): { exitCode: number; stdout: { text: string }; stderr: { text: string } } | null {
  if (!command.startsWith('gh api ')) return null
  let body: unknown = []
  let exitCode = 0
  let stderr = ''
  if (/\/issues\?state=all/.test(command)) {
    if (options.failRepoIssues) {
      return { exitCode: 1, stdout: { text: included({ message: options.failRepoIssues }, 500) }, stderr: { text: options.failRepoIssues } }
    }
    body = (options.issues ?? []).map(restIssue)
  } else if (/\/pulls\?state=all/.test(command)) {
    body = options.pulls ?? []
  } else if (/\/issues\/\d+\/comments/.test(command)) {
    const commandNumber = command.match(/\/issues\/(\d+)\/comments/)?.[1]
    const itemNumber = String(options.item?.number ?? String(options.item?.url ?? '').match(/\/issues\/(\d+)/)?.[1] ?? '')
    const comments = commandNumber === itemNumber
      ? (Array.isArray(options.item?.comments) ? options.item.comments as Array<Record<string, unknown>> : [])
      : (options.prComments ?? [])
    body = comments.map(restComment)
  } else if (/\/issues\/\d+\/timeline/.test(command)) {
    body = []
  } else if (/\/pulls\/\d+\/reviews/.test(command)) {
    body = options.reviews ?? []
  } else if (/\/pulls\/\d+\/requested_reviewers/.test(command)) {
    body = { users: [], teams: [] }
  } else if (/\/pulls\/\d+/.test(command)) {
    body = options.pr ?? {}
  } else if (/\/issues\/\d+/.test(command)) {
    body = restIssue(options.item ?? {})
  }
  return { exitCode, stdout: { text: included(body) }, stderr: { text: stderr } }
}

function createHandler(
  run?: (spec: { command: string; workdir?: string; stdin?: string; timeoutMs?: number }) => Promise<unknown>,
  start?: (spec: { command: string; workdir?: string; stdin?: string }) => unknown,
): RequestListener {
  let handler: RequestListener | null = null
  const ctx = {
    webServer: {
      register(route: { handler: RequestListener }) {
        handler = route.handler
        return () => {}
      },
    },
    shell: {
      resolve(spec: unknown) { return spec },
      run: run ?? (() => { throw new Error('shell must not run for rejected requests') }),
      start: start ?? (() => { throw new Error('shell must not run for rejected requests') }),
    },
  }
  apply(ctx as never)
  assert.ok(handler)
  return handler
}

async function post(
  listener: RequestListener,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = request({
        host: '127.0.0.1', port: address.port, path, method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
          ...(headers.origin === 'same-origin' ? { origin: `http://127.0.0.1:${address.port}` } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; error?: string },
        }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function get(
  listener: RequestListener,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: address.port, path, method: 'GET' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }))
      }).on('error', reject).end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('/develop rejects a real agent before any shell command without server authorization', async () => {
  const result = await post(createHandler(), '/clickvibe/api/develop', {
    url: 'https://github.com/ai-daming/clickvibe/issues/1', agent: 'codex',
  })
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /授权请求头/)
})

test('/authorize rejects cross-origin requests before fetching issue content', async () => {
  const result = await post(createHandler(), '/clickvibe/api/authorize', {
    action: 'develop', url: 'https://github.com/ai-daming/clickvibe/issues/1', agent: 'codex',
  }, {
    origin: 'https://evil.example',
    'x-clickvibe-request': '1',
  })
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /跨站/)
})

test('authorization route freezes the displayed snapshot and consumes tampered capabilities', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
    title: 'snapshot title', body: 'snapshot body', state: 'OPEN',
    updatedAt: '2026-08-21T00:00:00Z', comments: [{ author: { login: 'owner' }, body: 'review note' }],
  }
  const handler = createHandler(async (spec) => githubApi(spec.command, { item }) ?? ({
    exitCode: 0, stdout: { text: '' }, stderr: { text: '' },
  }))
  const expectedSnapshot = {
    url: item.url, title: item.title, body: item.body, state: item.state,
    updatedAt: item.updatedAt, comments: [{ author: 'owner', body: 'review note' }],
  }
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const authorized = await post(handler, '/clickvibe/api/authorize', {
    action: 'develop', url: item.url, agent: 'codex', context: '', expectedSnapshot,
  }, headers) as { status: number; body: { ok: boolean; authorizationId?: string; authorizationDigest?: string } }
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
  assert.equal(authorized.body.ok, true)

  const tampered = await post(handler, '/clickvibe/api/develop', {
    url: item.url, agent: 'codex', context: 'changed after confirmation',
    authorizationId: authorized.body.authorizationId,
    authorizationDigest: authorized.body.authorizationDigest,
  }, headers)
  assert.equal(tampered.status, 403)
  assert.match(tampered.body.error ?? '', /授权无效/)

  const replay = await post(handler, '/clickvibe/api/develop', {
    url: item.url, agent: 'codex', context: '',
    authorizationId: authorized.body.authorizationId,
    authorizationDigest: authorized.body.authorizationDigest,
  }, headers)
  assert.equal(replay.status, 403)
})

test('development rejects a confirmed snapshot when the issue changes before stage start', async () => {
  const url = 'https://github.com/ai-daming/clickvibe/issues/20'
  const oldItem = {
    url, title: 'old target', body: 'old acceptance', state: 'OPEN',
    updatedAt: '2026-08-22T05:00:00Z', comments: [],
  }
  let issueReads = 0
  const handler = createHandler(async (spec) => {
    if (/gh api .*\/issues\/20'/.test(spec.command)) {
      issueReads += 1
      const current = issueReads === 1 ? oldItem : {
        ...oldItem, body: 'new acceptance', updatedAt: '2026-08-22T06:00:00Z',
      }
      return githubApi(spec.command, { item: current })
    }
    return githubApi(spec.command, { item: oldItem }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const authorized = await post(handler, '/clickvibe/api/authorize', {
    action: 'develop', url, agent: 'codex', context: '', expectedSnapshot: oldItem,
  }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
  assert.equal(authorized.status, 200)
  const developed = await post(handler, '/clickvibe/api/develop', {
    url, agent: 'codex', context: '', authorizationId: authorized.body.authorizationId,
    authorizationDigest: authorized.body.authorizationDigest,
  }, headers)
  assert.equal(developed.status, 400)
  assert.match(developed.body.error ?? '', /内容在确认后已变化/)
  assert.equal(issueReads, 2)
})

test('/sync rejects worktree mutation without the same-origin privileged headers', async () => {
  const result = await post(createHandler(), '/clickvibe/api/sync', {
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
  })
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /授权请求头/)
})

test('/merge requires one-use authorization, exact reviewed HEAD, merge commit, cleanup and archive', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    const worktree = join(worktreeRoot, 'r-issue-23')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`)
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', worktree)
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    const reviewedBody = '## 验收标准\n- merge contract'
    workflow.events = [{
      kind: 'review', at: '2026-08-22T00:00:00Z', hash: 'abcdef1',
      verdict: { passed: true, issues: [] },
      issueContract: { bodyHash: issueBodyHash(reviewedBody), updatedAt: '2026-08-22T00:00:00Z' },
    }]
    await saveWorkflow(workflow)

    let merged = false
    let issueClosed = false
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url, number: 23, title: 'merge issue', body: reviewedBody,
          state: issueClosed ? 'CLOSED' : 'OPEN', updatedAt: '2026-08-22T00:00:00Z',
        },
        pr: {
          number: 29, state: merged ? 'closed' : 'open', merged_at: merged ? '2026-08-22T01:00:00Z' : null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890' }, base: { ref: 'main' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      if (spec.command.startsWith('gh pr merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: 'merged' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git show-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git ls-remote')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue close')) {
        issueClosed = true
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'merge', url: workflow.url,
    }, headers) as { status: number; body: { ok: boolean; authorizationId?: string; authorizationDigest?: string; target?: { prNumber: string; branch: string; head: string; mergeFlag: string }; preview?: { prNumber: string; branch: string; head: string; mergeFlag: string; cleanup: string[] } } }
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
    assert.deepEqual(authorized.body.preview, {
      prNumber: '29', branch: workflow.branch, head: 'abcdef1234567890', mergeFlag: '--merge',
      cleanup: ['worktree', '本地分支', '远端分支', 'Issue #23', 'workflow 归档'],
    })

    const tampered = await post(handler, '/clickvibe/api/merge', {
      url: workflow.url,
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
      target: { ...authorized.body.target, head: 'fffffffffffffff' },
    }, headers)
    assert.equal(tampered.status, 403)
    assert.equal(commands.some((command) => command.startsWith('gh pr merge')), false)
    const executionAuthorization = await post(handler, '/clickvibe/api/authorize', {
      action: 'merge', url: workflow.url,
    }, headers) as typeof authorized
    assert.equal(executionAuthorization.status, 200)

    const response = await post(handler, '/clickvibe/api/merge', {
      url: workflow.url,
      authorizationId: executionAuthorization.body.authorizationId,
      authorizationDigest: executionAuthorization.body.authorizationDigest,
      target: executionAuthorization.body.target,
    }, headers) as { status: number; body: { ok: boolean; archived?: boolean } }
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.archived, true)
    const mergeCommand = commands.find((command) => command.startsWith('gh pr merge')) ?? ''
    assert.match(mergeCommand, / --merge /)
    assert.match(mergeCommand, /--match-head-commit 'abcdef1234567890'/)
    assert.match(mergeCommand, /--body 'Closes #23'/)
    assert.doesNotMatch(mergeCommand, /--squash|--rebase|--delete-branch/)
    assert.equal(await loadWorkflow(workflow.key), null)
    const archived = await loadAllArchivedWorkflows()
    assert.equal(archived.length, 1)
    assert.equal(archived[0].delivery?.status, 'archived')
    assert.deepEqual(archived[0].delivery?.cleanup, {
      worktree: true, localBranch: true, remoteBranch: true, issue: true,
    })

    const replay = await post(handler, '/clickvibe/api/merge', {
      url: workflow.url,
      authorizationId: executionAuthorization.body.authorizationId,
      authorizationDigest: executionAuthorization.body.authorizationDigest,
      target: executionAuthorization.body.target,
    }, headers)
    assert.equal(replay.status, 403)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/merge rejects a stale review hash before invoking gh pr merge', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-stale-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`)
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', join(worktreeRoot, 'r-issue-23'))
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    workflow.events = [{ kind: 'review', at: 'now', hash: '1111111', verdict: { passed: true, issues: [] } }]
    await saveWorkflow(workflow)
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        pr: {
          number: 29, state: 'open', merged_at: null,
          head: { ref: workflow.branch, sha: '2222222222222222' }, base: { ref: 'main' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', { action: 'merge', url: workflow.url }, headers)
    assert.equal(authorized.status, 400)
    assert.match(authorized.body.error ?? '', /review.*哈希不一致/)
    assert.equal(commands.some((command) => command.startsWith('gh pr merge')), false)
    assert.equal((await loadWorkflow(workflow.key))?.delivery, undefined)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/merge authorization rejects a changed acceptance contract with the same PR HEAD', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-contract-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', join(tempHome, 'worktree'))
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    workflow.events = [{
      kind: 'review', at: 'now', hash: 'abcdef1', verdict: { passed: true, issues: [] },
      issueContract: {
        bodyHash: issueBodyHash('## 验收标准\n- reviewed contract'),
        updatedAt: '2026-08-22T00:00:00Z',
      },
    }]
    await saveWorkflow(workflow)
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url, number: 23, title: 'changed issue', body: '## 验收标准\n- changed contract',
          state: 'OPEN', updatedAt: '2026-08-22T01:00:00Z',
        },
        pr: {
          number: 29, state: 'open', merged_at: null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890' }, base: { ref: 'main' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const result = await post(handler, '/clickvibe/api/authorize', {
      action: 'merge', url: workflow.url,
    }, { origin: 'same-origin', 'x-clickvibe-request': '1' })
    assert.equal(result.status, 400)
    assert.match(result.body.error ?? '', /验收契约已变更.*重新 Review/)
    assert.equal(commands.some((command) => command.startsWith('gh pr merge')), false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('cleanup failure keeps merged terminal state and retries without merging again', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-retry-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    const worktree = join(worktreeRoot, 'r-issue-23')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`)
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', worktree)
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    const reviewedBody = '## 验收标准\n- retry cleanup contract'
    workflow.events = [{
      kind: 'review', at: 'now', hash: 'abcdef1', verdict: { passed: true, issues: [] },
      issueContract: { bodyHash: issueBodyHash(reviewedBody), updatedAt: '2026-08-22T00:00:00Z' },
    }]
    await saveWorkflow(workflow)

    let merged = false
    let removeAttempts = 0
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url, number: 23, title: 'merge issue', body: reviewedBody,
          state: 'CLOSED', updatedAt: '2026-08-22T00:00:00Z',
        },
        pr: {
          number: 29, state: merged ? 'closed' : 'open', merged_at: merged ? '2026-08-22T01:00:00Z' : null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890' }, base: { ref: 'main' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      if (spec.command.startsWith('gh pr merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain') return {
        exitCode: 0, stdout: { text: removeAttempts === 0 ? `worktree ${worktree}\nbranch refs/heads/${workflow.branch}\n` : '' }, stderr: { text: '' },
      }
      if (spec.command.startsWith('git worktree remove')) {
        removeAttempts++
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'worktree contains changes' } }
      }
      if (spec.command.startsWith('if git show-ref') || spec.command.startsWith('if git ls-remote')) {
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = () => post(handler, '/clickvibe/api/authorize', { action: 'merge', url: workflow.url }, headers) as Promise<{
      status: number; body: { authorizationId?: string; authorizationDigest?: string; target?: { prNumber: string; branch: string; head: string; mergeFlag: string } }
    }>
    const firstAuthorization = await authorize()
    const first = await post(handler, '/clickvibe/api/merge', {
      url: workflow.url,
      authorizationId: firstAuthorization.body.authorizationId,
      authorizationDigest: firstAuthorization.body.authorizationDigest,
      target: firstAuthorization.body.target,
    }, headers)
    assert.equal(first.status, 400)
    assert.match(first.body.error ?? '', /PR 已合并;移除 worktree失败,可重试/)
    const pending = await loadWorkflow(workflow.key)
    assert.equal(pending?.delivery?.status, 'cleanup-pending')
    assert.equal(pending?.delivery?.cleanup.worktree, false)

    const secondAuthorization = await authorize()
    assert.equal(secondAuthorization.status, 200)
    const second = await post(handler, '/clickvibe/api/merge', {
      url: workflow.url,
      authorizationId: secondAuthorization.body.authorizationId,
      authorizationDigest: secondAuthorization.body.authorizationDigest,
      target: secondAuthorization.body.target,
    }, headers)
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(commands.filter((command) => command.startsWith('gh pr merge')).length, 1)
    assert.equal((await loadAllArchivedWorkflows())[0]?.delivery?.status, 'archived')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/state uses the live GitHub issue state instead of the stored issueState', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-live-issue-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', join(tempHome, 'missing-worktree'))
    workflow.issueState = 'OPEN'
    await saveWorkflow(workflow)
    const handler = createHandler(async (spec) => {
      const api = githubApi(spec.command, {
        item: { url: workflow.url, number: 23, state: 'CLOSED' },
        pr: {
          number: 29, state: 'open', merged_at: null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890' }, base: { ref: 'main' },
          html_url: 'https://github.com/o/r/pull/29',
        },
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const response = await post(handler, '/clickvibe/api/state', { url: workflow.url }) as {
      status: number; body: { workflows?: Array<{ issueState: string; derived: { nextAction: { kind: string } } }> }
    }
    assert.equal(response.status, 200)
    assert.equal(response.body.workflows?.[0].issueState, 'CLOSED')
    assert.equal(response.body.workflows?.[0].derived.nextAction.kind, 'none')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/projects route returns the configured-project envelope without invoking shell', async () => {
  const result = await post(createHandler(), '/clickvibe/api/projects', {})
  assert.equal(result.status, 200)
  assert.equal(Array.isArray((result.body as { projects?: unknown[] }).projects), true)
})

test('/state and repo/issues share one repository fetch TTL while manual refresh bypasses it', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-fetch-ttl-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), [
      'repos:',
      `  o/r: ${repo}`,
      'fetchTtlSeconds: 45',
      '',
    ].join('\n'))
    let fetches = 0
    const handler = createHandler(async ({ command }) => {
      if (command === 'git fetch origin --prune') {
        fetches++
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      if (command.startsWith('gh api ')) {
        return githubApi(command)
      }
      if (command.startsWith('git for-each-ref') || command.startsWith('git symbolic-ref')) {
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const state = await post(handler, '/clickvibe/api/state', { repoKey: 'o/r' })
    const list = await post(handler, '/clickvibe/api/repo/issues', { repoKey: 'o/r' })
    const forced = await post(handler, '/clickvibe/api/repo/issues', { repoKey: 'o/r', forceRefresh: true })

    assert.equal(state.status, 200)
    assert.equal(list.status, 200)
    assert.equal(forced.status, 200)
    assert.equal(fetches, 2)
    assert.equal((state.body as { freshness?: { refreshed: boolean } }).freshness?.refreshed, true)
    assert.equal((list.body as { freshness?: { refreshed: boolean } }).freshness?.refreshed, false)
    assert.equal((forced.body as { freshness?: { refreshed: boolean } }).freshness?.refreshed, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/state keeps local-ref state readable and marks freshness stale when fetch fails', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-fetch-stale-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), [
      'repos:',
      `  o/r: ${repo}`,
      '',
    ].join('\n'))
    const handler = createHandler(async ({ command }) => {
      assert.equal(command, 'git fetch origin --prune')
      return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline' } }
    })

    const result = await post(handler, '/clickvibe/api/state', { repoKey: 'o/r' })

    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual((result.body as { workflows?: unknown[] }).workflows, [])
    assert.equal((result.body as { freshness?: { stale: boolean } }).freshness?.stale, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/state schedules dependency refreshes for a remote-only configured repository', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-remote-dependencies-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), [
      'repos:',
      '  remote/only: /path/not/on/this/host',
      '',
    ].join('\n'))
    const handler = createHandler()

    const first = await post(handler, '/clickvibe/api/state', { repoKey: 'remote/only' })
    const second = await post(handler, '/clickvibe/api/state', { repoKey: 'remote/only' })

    assert.equal((first.body as { dependenciesRefreshDue?: boolean }).dependenciesRefreshDue, true)
    assert.equal((second.body as { dependenciesRefreshDue?: boolean }).dependenciesRefreshDue, false)
    assert.equal((first.body as { freshness?: unknown }).freshness, null)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/state returns stale local facts within a bounded wait when git fetch hangs', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-fetch-hang-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), [
      'repos:',
      `  hanging/repo: ${repo}`,
      '',
    ].join('\n'))
    const handler = createHandler(async ({ command }) => {
      assert.equal(command, 'git fetch origin --prune')
      return new Promise(() => {})
    })

    const startedAt = Date.now()
    const result = await post(handler, '/clickvibe/api/state', { repoKey: 'hanging/repo' })
    const elapsedMs = Date.now() - startedAt

    assert.equal(result.status, 200)
    assert.equal((result.body as { freshness?: { stale: boolean; refreshing: boolean } }).freshness?.stale, true)
    assert.equal((result.body as { freshness?: { stale: boolean; refreshing: boolean } }).freshness?.refreshing, true)
    assert.ok(elapsedMs < 3_000, `state response took ${elapsedMs}ms`)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a rejected dry-run worktree attempt preserves the previous durable dev history', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-history-conflict-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    const target = join(worktreeRoot, 'repo', 'repo-issue-905')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'unregistered.txt'), 'must not be removed')
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), [
      'repos:',
      `  o/r: ${repo}`,
      `worktreeRoot: ${worktreeRoot}`,
      '',
    ].join('\n'))
    await appendLog('o-r-905', 'dev', 'previous completed task history')

    const issue = {
      url: 'https://github.com/o/r/issues/905', title: 'conflicting worktree', body: '',
      state: 'OPEN', updatedAt: 'now', comments: [],
    }
    const handler = createHandler(async ({ command }) => {
      const api = githubApi(command, { item: issue })
      if (api) return api
      if (command === 'git fetch origin --prune') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
      if (command === "git rev-parse --short 'origin/main'") return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (command === 'git worktree list --porcelain') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (command.includes("git show-ref --verify --quiet 'refs/heads/repo-issue-905'")) return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
      throw new Error(`unexpected command: ${command}`)
    })

    const result = await post(handler, '/clickvibe/api/develop', { url: issue.url, agent: 'dryrun' })
    assert.equal(result.status, 400)
    assert.match(result.body.error ?? '', /worktree 冲突/)
    const history = await readLogHistory('o-r-905', 'dev')
    assert.equal(history[0], 'previous completed task history')
    assert.ok(history.some((line) => line.includes('worktree 冲突')))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/history restores the complete disk log by task id after Host restart', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-history-restart-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow(
      'o-r-903',
      'https://github.com/o/r/issues/903',
      join(tempHome, 'worktree'),
    )
    workflow.devTaskId = 'dev-before-restart'
    await saveWorkflow(workflow)
    await appendLog(workflow.key, 'dev', 'thinking one')
    await appendLog(workflow.key, 'dev', 'thinking two')

    const result = await get(createHandler(), '/clickvibe/api/history?taskId=dev-before-restart')
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.lines, ['thinking one', 'thinking two'])
    assert.equal(result.body.cursor, 0)
    assert.equal(result.body.active, false)
    assert.equal(result.body.kind, 'dev')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/history accepts a safe workflow key and rejects unknown or traversal targets', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-history-key-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow('o-r-904', 'https://github.com/o/r/issues/904', join(tempHome, 'worktree'))
    await saveWorkflow(workflow)
    await appendLog(workflow.key, 'review', 'review history')
    const handler = createHandler()

    const found = await get(handler, `/clickvibe/api/history?key=${workflow.key}&kind=review`)
    assert.equal(found.status, 200)
    assert.deepEqual(found.body.lines, ['review history'])

    const traversal = await get(handler, '/clickvibe/api/history?key=..%2Fsecret&kind=dev')
    assert.equal(traversal.status, 404)
    const missing = await get(handler, '/clickvibe/api/history?taskId=missing')
    assert.equal(missing.status, 404)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/stream reports a cleaned-up task as 404 instead of a silent empty SSE', async () => {
  const result = await get(createHandler(), '/clickvibe/api/stream?taskId=already-cleaned')
  assert.equal(result.status, 404)
  assert.match(String(result.body.error), /未知任务/)
})

function interruptedWorkflow(key: string, url: string, worktree: string): IssueWorkflow {
  return {
    key, url, repoKey: 'o/r', worktree, branch: 'r-issue-17', stage: 'developing',
    devAgent: 'codex', devTaskId: 'old-dev', devSessionId: 'dead-session', devSessionAgent: 'codex', devInterrupted: true,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null, reviewSessionAgent: null,
    reviewResult: null, prNumber: '29', issueState: 'OPEN', baseRef: 'origin/main @ abc',
    issueSnapshot: {
      url, title: 'persisted issue', body: '## 验收标准\n- persisted', state: 'OPEN',
      updatedAt: '2026-08-21T00:00:00Z', comments: [],
    },
    updatedAt: 1, events: [],
  }
}

async function waitForTask(listener: RequestListener, taskId: string): Promise<{ delta: string[] }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = await post(listener, '/clickvibe/api/develop/poll', { taskId, cursor: 0 })
    const body = polled.body as { ok: boolean; done?: boolean; delta?: string[] }
    if (body.done) return { delta: body.delta ?? [] }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`task ${taskId} did not finish`)
}

test('invalid exact dev session falls back once to a fresh session on the same task', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-fallback-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-917', 'https://github.com/o/r/issues/917', worktree)
    workflow.reviewResult = { passed: false, issues: ['修复竞态', '补充失败测试'] }
    await saveWorkflow(workflow)
    await appendLog(workflow.key, 'dev', 'prior run must be rotated')
    const starts: Array<{ command: string; workdir?: string; prompt: string }> = []
    const comments: Array<{ command: string; body: string }> = []
    const currentIssue = {
      url: workflow.url, title: 'resume issue', body: '## 验收标准\n- fallback', state: 'OPEN', updatedAt: 'now',
      comments: [],
    }
    const reviewComments = [{ author: { login: 'review-bot' }, body: '== Review Meta ==\n- event: review\n- passed: false\n\n- 修复竞态\n- 补充失败测试' }]
    const handler = createHandler(async (spec) => {
      const api = githubApi(spec.command, { item: currentIssue, prComments: reviewComments })
      if (api) return api
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/pull/29#issuecomment-1' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      starts.push({ command: spec.command, workdir: spec.workdir, prompt: spec.stdin ?? '' })
      const fresh = starts.length === 2
      let read = false
      return {
        status: 'running', exitCode: fresh ? 0 : 1,
        done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return { delta: fresh ? '{"type":"thread.started","thread_id":"new-session"}\n' : 'no rollout found\n', lossy: false }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'resume', url: workflow.url, agent: 'codex', context: '',
    }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = await post(handler, '/clickvibe/api/resume', {
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    }, headers) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    const completed = await waitForTask(handler, resumed.body.taskId)
    assert.equal(starts.length, 2)
    assert.match(starts[0].command, /danger-full-access resume 'dead-session'/)
    assert.equal(starts[1].command, `codex exec -c 'approval_policy="never"' -s danger-full-access --json -`)
    assert.deepEqual(starts.map((start) => start.workdir), [worktree, worktree])
    for (const start of starts) {
      assert.match(start.prompt, /=== 需求快照 ===/)
      assert.match(start.prompt, /updatedAt: now/)
      assert.match(start.prompt, /## 验收标准\n- fallback/)
      assert.match(start.prompt, /== Review Meta ==\n- event: review/)
      assert.match(start.prompt, /修复竞态/)
      assert.match(start.prompt, /=== 信任边界 ===/)
    }
    assert.ok(completed.delta.some((line) => line.includes('回退全新会话')))
    assert.ok(completed.delta.some((line) => line.includes('恢复结束,退出码 0')))
    assert.equal((await readLogHistory(workflow.key, 'dev')).includes('prior run must be rotated'), false)
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.devSessionId, 'new-session')
    assert.equal(reloaded?.devSessionAgent, 'codex')
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /github\.com\/o\/r\/pull\/29/)
    assert.match(comments[0].body, /^== Dev Meta ==\n- event: dev\n- commit: abc123\n- issue: #917\n- fixed: 2/m)
    assert.match(comments[0].body, /- 修复竞态\n- 补充失败测试/)
    assert.equal(reloaded?.events.at(-1)?.publication?.status, 'posted')
    assert.equal(reloaded?.events.at(-1)?.publication?.target, 'pr')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('completed development without a PR appends its Dev Meta comment to the issue', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-comment-fallback-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-920', 'https://github.com/o/r/issues/920', worktree)
    workflow.prNumber = null
    await saveWorkflow(workflow)
    const comments: Array<{ command: string; body: string }> = []
    const prompts: string[] = []
    const handler = createHandler(async (spec) => {
      if (/gh api .*\/issues\/920'/.test(spec.command)) {
        return { exitCode: 1, stdout: { text: included({ message: 'offline' }, 500) }, stderr: { text: 'offline' } }
      }
      if (spec.command === 'git rev-parse --short HEAD') {
        return { exitCode: 0, stdout: { text: 'def4567' }, stderr: { text: '' } }
      }
      const api = githubApi(spec.command)
      if (api) return api
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/issues/920#issuecomment-3' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      prompts.push(spec.stdin ?? '')
      let read = false
      return {
        status: 'running', exitCode: 0,
        done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return { delta: '{"type":"thread.started","thread_id":"continued-session"}\n', lossy: false }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'resume', url: workflow.url, agent: 'codex', context: '',
    }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = await post(handler, '/clickvibe/api/resume', {
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    }, headers) as { status: number; body: { taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    await waitForTask(handler, resumed.body.taskId)

    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /持久化回退\(可能过期\)/)
    assert.match(prompts[0], /updatedAt: 2026-08-21T00:00:00Z/)
    assert.match(prompts[0], /## 验收标准\n- persisted/)
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /github\.com\/o\/r\/issues\/920/)
    assert.match(comments[0].body, /^== Dev Meta ==\n- event: dev\n- commit: def4567\n- issue: #920\n- fixed: 0/m)
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.events.at(-1)?.publication?.target, 'issue')
    assert.equal(reloaded?.events.at(-1)?.publication?.status, 'posted')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('concurrent resume requests reserve one workflow task before refreshing the snapshot', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-resume-gate-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-930', 'https://github.com/o/r/issues/930', worktree)
    workflow.prNumber = null
    workflow.devSessionId = null
    await saveWorkflow(workflow)
    let issueReads = 0
    let starts = 0
    const currentIssue = {
      url: workflow.url, title: 'resume gate', body: '## 验收标准\n- one task',
      state: 'OPEN', updatedAt: '2026-08-22T07:00:00Z', comments: [],
    }
    const handler = createHandler(async (spec) => {
      if (/gh api .*\/issues\/930'/.test(spec.command)) {
        issueReads += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return githubApi(spec.command, { item: currentIssue })
      }
      const api = githubApi(spec.command, { item: currentIssue })
      if (api) return api
      if (spec.command.startsWith('gh issue comment')) {
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/issues/930#issuecomment-1' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, () => {
      starts += 1
      let read = false
      return {
        status: 'running', exitCode: 0,
        done: new Promise<void>((resolve) => setTimeout(resolve, 50)),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return { delta: '{"type":"thread.started","thread_id":"resume-gate"}\n', lossy: false }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = () => post(handler, '/clickvibe/api/authorize', {
      action: 'resume', url: workflow.url, agent: 'codex', context: '',
    }, headers) as Promise<{ status: number; body: { authorizationId?: string; authorizationDigest?: string } }>
    const [firstAuth, secondAuth] = await Promise.all([authorize(), authorize()])
    const resume = (authorization: typeof firstAuth.body) => post(handler, '/clickvibe/api/resume', {
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: authorization.authorizationId,
      authorizationDigest: authorization.authorizationDigest,
    }, headers) as Promise<{ status: number; body: { ok: boolean; taskId?: string } }>
    const [first, second] = await Promise.all([resume(firstAuth.body), resume(secondAuth.body)])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.body.taskId, second.body.taskId)
    assert.equal(issueReads, 1)
    assert.equal(starts, 1)
    assert.ok(first.body.taskId)
    await waitForTask(handler, first.body.taskId)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('comment publication failure keeps the delivery event and stores a bounded visible error', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-comment-failure-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-921', 'https://github.com/o/r/issues/921', worktree)
    workflow.reviewResult = { passed: false, issues: ['must remain traceable'] }
    await saveWorkflow(workflow)
    const handler = createHandler(async (spec) => {
      if (spec.command === 'git rev-parse --short HEAD') {
        return { exitCode: 0, stdout: { text: '987abcd' }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('gh issue comment')) {
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: `offline-${'x'.repeat(700)}` } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, () => {
      let read = false
      return {
        status: 'running', exitCode: 0,
        done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return { delta: '{"type":"thread.started","thread_id":"failure-session"}\n', lossy: false }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'resume', url: workflow.url, agent: 'codex', context: '',
    }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = await post(handler, '/clickvibe/api/resume', {
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    }, headers) as { status: number; body: { taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    await waitForTask(handler, resumed.body.taskId)

    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.stage, 'review-ready')
    assert.equal(reloaded?.events.length, 1)
    assert.equal(reloaded?.events[0].hash, '987abcd')
    assert.equal(reloaded?.events[0].fixed, 1)
    assert.equal(reloaded?.events[0].publication?.target, 'pr')
    assert.equal(reloaded?.events[0].publication?.status, 'failed')
    assert.equal(reloaded?.events[0].publication?.error?.length, 500)
    assert.match(reloaded?.events[0].publication?.error ?? '', /offline-/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('invalid exact review session clears the stale id and falls back to a fresh review', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-fallback-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-918', 'https://github.com/o/r/issues/918', worktree)
    workflow.stage = 'review-ready'
    workflow.reviewSessionId = 'dead-review'
    workflow.reviewSessionAgent = 'codex'
    await saveWorkflow(workflow)
    const starts: Array<{ command: string; prompt: string }> = []
    const reviewedBody = '## 验收标准\n- frozen review contract'
    const reviewedUpdatedAt = '2026-08-22T01:02:03Z'
    const issueSpill = join(tempHome, 'issue-contract.json')
    const currentIssue = {
      url: workflow.url, number: 918,
      title: 'review issue', body: reviewedBody, state: 'OPEN', updatedAt: reviewedUpdatedAt,
      comments: [{ author: { login: 'bot' }, body: 'related note' }],
    }
    await writeFile(issueSpill, included(restIssue(currentIssue)))
    let reviewFetches = 0
    const comments: Array<{ command: string; body: string }> = []
    const approvals: string[] = []
    const issueTimeouts: number[] = []
    const pr = {
      number: 29, state: 'open', html_url: 'https://github.com/o/r/pull/29', updated_at: reviewedUpdatedAt,
      base: { ref: 'main' }, head: { ref: workflow.branch },
    }
    const handler = createHandler(async (spec) => {
      if (spec.command === 'git fetch origin --prune') {
        reviewFetches++
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      if (/gh api .*\/issues\/918'/.test(spec.command)) {
        issueTimeouts.push(spec.timeoutMs ?? 0)
        return {
          exitCode: 0,
          stdout: { text: 'truncated tail', truncated: true, spillPath: issueSpill },
          stderr: { text: '' },
        }
      }
      const api = githubApi(spec.command, { item: currentIssue, pr })
      if (api) return api
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/pull/29#issuecomment-2' }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('gh pr review')) {
        approvals.push(spec.command)
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      starts.push({ command: spec.command, prompt: spec.stdin ?? '' })
      const fresh = starts.length === 2
      let read = false
      return {
        status: 'running', exitCode: fresh ? 0 : 1,
        done: (async () => {
          if (fresh) {
            await mkdir(join(worktree, '.clickvibe'), { recursive: true })
            await writeFile(join(worktree, '.clickvibe', 'review-result.json'), '{"passed":true,"issues":[]}')
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
        })(),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return { delta: fresh ? '{"type":"thread.started","thread_id":"new-review"}\n' : 'no rollout found\n', lossy: false }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'review', url: workflow.url, agent: 'codex', context: '',
    }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const reviewed = await post(handler, '/clickvibe/api/review', {
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    }, headers) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body))
    assert.ok(reviewed.body.taskId)
    const completed = await waitForTask(handler, reviewed.body.taskId)
    assert.equal(starts.length, 2)
    assert.equal(reviewFetches, 1)
    assert.match(starts[0].command, /danger-full-access resume 'dead-review'/)
    assert.equal(starts[1].command, `codex exec -c 'approval_policy="never"' -s danger-full-access --json -`)
    for (const start of starts) {
      assert.match(start.prompt, /=== 需求快照 ===/)
      assert.match(start.prompt, /updatedAt: 2026-08-22T01:02:03Z/)
      assert.match(start.prompt, /frozen review contract/)
      assert.match(start.prompt, new RegExp(`契约正文 SHA-256: ${issueBodyHash(reviewedBody)}`))
      assert.match(start.prompt, /PR: https:\/\/github\.com\/o\/r\/pull\/29/)
      assert.match(start.prompt, /被审 commit: abc123/)
      assert.match(start.prompt, /\[验证不通过\].*\[无法验证\]/)
      assert.match(start.prompt, /=== 信任边界 ===/)
    }
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.reviewSessionId, 'new-review')
    assert.equal(reloaded?.reviewSessionAgent, 'codex')
    assert.equal(reloaded?.reviewResult?.passed, true)
    assert.deepEqual(issueTimeouts, [20000])
    assert.deepEqual(reloaded?.events.at(-1)?.issueContract, {
      bodyHash: issueBodyHash(reviewedBody), updatedAt: reviewedUpdatedAt,
    })
    assert.ok(completed.delta.some((line) => line.includes('review 结束,退出码 0')))
    assert.ok(completed.delta.some((line) => line.includes('review 结论来源')))
    assert.equal(reloaded?.reviewResult?.commentUrl, 'https://github.com/o/r/pull/29#issuecomment-2')
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /github\.com\/o\/r\/pull\/29/)
    assert.match(comments[0].body, /^== Review Meta ==\n- event: review\n- commit: abc123\n- issue: #918\n- passed: true\n- next: merge/m)
    assert.match(comments[0].body, /下一步:可合并当前提交。/)
    assert.deepEqual(approvals, [
      "gh pr review 'https://github.com/o/r/pull/29' --approve --body 'LGTM'",
    ])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('duplicate review requests reuse the reserved task before fetching the Issue contract', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-gate-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-920', 'https://github.com/o/r/issues/920', worktree)
    workflow.stage = 'review-ready'
    await saveWorkflow(workflow)

    let issueCalls = 0
    let notifyIssueEntered!: () => void
    let releaseIssue!: () => void
    const issueEntered = new Promise<void>((resolve) => { notifyIssueEntered = resolve })
    const issueBlocked = new Promise<void>((resolve) => { releaseIssue = resolve })
    let finishProcess!: () => void
    const processDone = new Promise<void>((resolve) => { finishProcess = resolve })
    const currentIssue = {
      url: workflow.url, number: 920, title: 'review issue', body: '## 验收标准\n- gate',
      state: 'OPEN', updatedAt: '2026-08-22T03:04:05Z', comments: [],
    }
    const handler = createHandler(async (spec) => {
      if (/gh api .*\/issues\/920'/.test(spec.command)) {
        issueCalls += 1
        notifyIssueEntered()
        await issueBlocked
        return githubApi(spec.command, { item: currentIssue })
      }
      const api = githubApi(spec.command, {
        item: currentIssue,
        pr: { number: 29, state: 'open', html_url: 'https://github.com/o/r/pull/29', base: { ref: 'main' }, head: { ref: workflow.branch } },
      })
      if (api) return api
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'gate123' }, stderr: { text: '' } }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, () => ({
      status: 'running', exitCode: 0, done: processDone,
      readOutput() { return { delta: '', lossy: false } },
      kill() { return true },
    }))
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = async () => post(handler, '/clickvibe/api/authorize', {
      action: 'review', url: workflow.url, agent: 'codex', context: '',
    }, headers) as Promise<{ status: number; body: { authorizationId?: string; authorizationDigest?: string } }>
    const [auth1, auth2] = await Promise.all([authorize(), authorize()])
    const reviewPayload = (auth: typeof auth1) => ({
      url: workflow.url, agent: 'codex', context: '',
      authorizationId: auth.body.authorizationId,
      authorizationDigest: auth.body.authorizationDigest,
    })

    const firstPromise = post(handler, '/clickvibe/api/review', reviewPayload(auth1), headers)
    await issueEntered
    const second = await Promise.race([
      post(handler, '/clickvibe/api/review', reviewPayload(auth2), headers),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('duplicate review waited for contract fetch')), 200)),
    ]) as { status: number; body: { taskId?: string } }
    assert.equal(second.status, 200)
    assert.equal(issueCalls, 1)

    releaseIssue()
    const first = await firstPromise as { status: number; body: { taskId?: string } }
    assert.equal(first.status, 200)
    assert.equal(first.body.taskId, second.body.taskId)
    await mkdir(join(worktree, '.clickvibe'), { recursive: true })
    await writeFile(join(worktree, '.clickvibe', 'review-result.json'), '{"passed":true,"issues":[]}')
    finishProcess()
    assert.ok(first.body.taskId)
    await waitForTask(handler, first.body.taskId)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('cross-agent review starts fresh and an empty failed verdict requires re-review', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-owner-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-919', 'https://github.com/o/r/issues/919', worktree)
    workflow.stage = 'review-ready'
    workflow.reviewAgent = 'codex'
    workflow.reviewSessionId = 'codex-review'
    workflow.reviewSessionAgent = 'codex'
    workflow.reviewResult = { passed: false, issues: ['old issue'] }
    await saveWorkflow(workflow)
    const starts: string[] = []
    const reviewedBody = '## 验收标准\n- current contract'
    const handler = createHandler(async (spec) => {
      const api = githubApi(spec.command, {
        item: { url: workflow.url, number: 919, title: 'review issue', body: reviewedBody, state: 'OPEN', updatedAt: '2026-08-22T02:03:04Z' },
        pr: { number: 29, base: { ref: 'main' }, head: { ref: workflow.branch } },
      })
      if (api) return api
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'def456' }, stderr: { text: '' } }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      starts.push(spec.command)
      let read = false
      return {
        status: 'running', exitCode: 0,
        done: (async () => {
          await mkdir(join(worktree, '.clickvibe'), { recursive: true })
          await writeFile(join(worktree, '.clickvibe', 'review-result.json'), '{"passed":false,"issues":[]}')
          await new Promise((resolve) => setTimeout(resolve, 5))
        })(),
        readOutput() {
          if (read) return { delta: '', lossy: false }
          read = true
          return {
            delta: '{"type":"system","session_id":"new-claude"}\n{"type":"result","session_id":"new-claude"}\n',
            lossy: false,
          }
        },
        kill() { return true },
      }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = await post(handler, '/clickvibe/api/authorize', {
      action: 'review', url: workflow.url, agent: 'claude', context: '',
    }, headers) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const reviewed = await post(handler, '/clickvibe/api/review', {
      url: workflow.url, agent: 'claude', context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    }, headers) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body))
    assert.ok(reviewed.body.taskId)
    await waitForTask(handler, reviewed.body.taskId)
    assert.deepEqual(starts, ['claude -p --dangerously-skip-permissions --verbose --output-format stream-json'])
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.reviewSessionId, 'new-claude')
    assert.equal(reloaded?.reviewSessionAgent, 'claude')
    assert.equal(reloaded?.reviewResult, null)
    assert.equal(reloaded?.stage, 'review-ready')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})



test('/fetch resolves blockedBy from the body and blocking from a repo scan', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/7',
    number: 7, title: 'issue 7', state: 'OPEN',
    body: '## 目标\n做 X\n\n## 依赖\n\nBlocked by #5', comments: [],
  }
  const issues = [
    { number: 5, title: 'issue 5', state: 'OPEN', body: '## 目标\nx' },
    { number: 7, title: 'issue 7', state: 'OPEN', body: '## 依赖\n\nBlocked by #5' },
    { number: 8, title: 'issue 8', state: 'OPEN', body: '## 依赖\n\nBlocked by #7' },
  ]
  const handler = createHandler(async (spec) => {
    return githubApi(spec.command, { item, issues }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const result = await post(handler, '/clickvibe/api/fetch', { url: item.url })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const deps = (result.body as { ok: true; data: { dependencies?: { blockedBy: { number: number }[]; blocking: { number: number }[] } } }).data.dependencies
  assert.ok(deps)
  assert.deepEqual(deps.blockedBy.map((d) => d.number), [5])
  assert.deepEqual(deps.blocking.map((d) => d.number), [8])
})

test('/fetch on an issue without a 依赖 section yields no blockedBy (and no blocking)', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/5',
    number: 5, title: 'issue 5', state: 'OPEN',
    body: '## 目标\n做 Y', comments: [],
  }
  const issues = [
    { number: 5, title: 'issue 5', state: 'OPEN', body: '## 目标\n做 Y' },
    { number: 7, title: 'issue 7', state: 'OPEN', body: '## 依赖\n\nBlocked by #5' },
  ]
  const handler = createHandler(async (spec) => {
    return githubApi(spec.command, { item, issues }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const result = await post(handler, '/clickvibe/api/fetch', { url: item.url })
  assert.equal(result.status, 200)
  const deps = (result.body as { ok: true; data: { dependencies?: { blockedBy: unknown[]; blocking: unknown[] } } }).data.dependencies
  assert.ok(deps)
  assert.deepEqual(deps.blockedBy, [])
  assert.deepEqual(deps.blocking.map((d) => (d as { number: number }).number), [7])
})

test('/develop automatic mode fails closed before worktree creation for invalid or blocked issues', async () => {
  const url = 'https://github.com/o/r/issues/77'
  const invalid = {
    url, number: 77, title: 'invalid', state: 'OPEN', updatedAt: '2026-08-22T00:00:00Z',
    body: '## 目标\n做事\n\n## 依赖\n无', comments: [],
  }
  const invalidHandler = createHandler(async (spec) => {
    const api = githubApi(spec.command, { item: invalid, issues: [invalid] })
    if (api) return api
    throw new Error(`worktree command must not run: ${spec.command}`)
  })
  const invalidResult = await post(invalidHandler, '/clickvibe/api/develop', {
    url, agent: 'dryrun', automatic: true,
  })
  assert.equal(invalidResult.status, 400)
  assert.match(invalidResult.body.error ?? '', /契约缺失: 验收标准/)

  const blocked = {
    ...invalid,
    title: 'blocked',
    body: '## 目标\n做事\n\n## 验收标准\n- [ ] 完成\n\n## 依赖\nBlocked by #8',
  }
  const dependency = { number: 8, title: 'dependency', state: 'OPEN', body: '' }
  const blockedHandler = createHandler(async (spec) => {
    const api = githubApi(spec.command, { item: blocked, issues: [blocked, dependency] })
    if (api) return api
    throw new Error(`worktree command must not run: ${spec.command}`)
  })
  const blockedResult = await post(blockedHandler, '/clickvibe/api/develop', {
    url, agent: 'dryrun', automatic: true,
  })
  assert.equal(blockedResult.status, 400)
  assert.match(blockedResult.body.error ?? '', /存在未完成的直接依赖/)
})

test('/fetch keeps issue data but reports dependency refresh failure without inventing an empty graph', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/938',
    number: 938, title: 'dependency refresh failure', state: 'OPEN',
    body: '## 依赖\n\nBlocked by #4', comments: [],
  }
  const handler = createHandler(async (spec) => {
    const api = githubApi(spec.command, { item, failRepoIssues: 'offline' })
    if (api) return api
    throw new Error(`unexpected command: ${spec.command}`)
  })

  const result = await post(handler, '/clickvibe/api/fetch', { url: item.url })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.match((result.body as { dependencyError?: string }).dependencyError ?? '', /offline/)
  assert.equal((result.body as { data?: { dependencies?: unknown } }).data?.dependencies, undefined)
})

test('/fetch maps PR REST fields and latest reviews without any GraphQL read command', async () => {
  const url = 'https://github.com/o/r/pull/41'
  const commands: string[] = []
  const pr = {
    number: 41, title: 'REST PR', state: 'open', body: 'body', html_url: url,
    user: { login: 'author' }, created_at: '2026-08-22T01:00:00Z', updated_at: '2026-08-22T02:00:00Z',
    additions: 12, deletions: 3, changed_files: 2, commits: 4, draft: false,
    mergeable: true, mergeable_state: 'clean', base: { ref: 'main' }, head: { ref: 'feature', sha: 'abc123' },
  }
  const reviews = [
    { id: 1, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-22T02:00:00Z' },
    { id: 2, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-22T03:00:00Z' },
  ]
  const handler = createHandler(async (spec) => {
    commands.push(spec.command)
    const api = githubApi(spec.command, {
      pr,
      reviews,
      prComments: [{ author: { login: 'commenter' }, body: 'looks good', createdAt: '2026-08-22T03:00:00Z' }],
    })
    if (api) return api
    throw new Error(`unexpected command: ${spec.command}`)
  })

  const first = await post(handler, '/clickvibe/api/fetch', { url }) as {
    status: number
    body: { ok: boolean; data?: { item?: Record<string, unknown> } }
  }
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data?.item?.reviewDecision, 'APPROVED')
  assert.equal(first.body.data?.item?.changedFiles, 2)
  assert.equal(first.body.data?.item?.baseRefName, 'main')
  assert.equal((first.body.data?.item?.comments as unknown[])?.length, 1)
  assert.ok(commands.length >= 4)
  assert.ok(commands.every((command) => command.startsWith('gh api ')))

  const readsAfterFirst = commands.length
  const second = await post(handler, '/clickvibe/api/fetch', { url })
  assert.equal(second.status, 200)
  assert.equal(commands.length, readsAfterFirst, 'unchanged PR detail should be served entirely from cache')
})

test('rate-limit response opens a circuit and returns the friendly recovery time on later routes', async () => {
  const reset = Math.floor((Date.now() + 10 * 60_000) / 1000)
  let requests = 0
  const handler = createHandler(async () => {
    requests++
    return {
      exitCode: 1,
      stdout: { text: [
        'HTTP/2.0 403 Forbidden',
        'x-ratelimit-remaining: 0',
        `x-ratelimit-reset: ${reset}`,
        '',
        JSON.stringify({ message: 'API rate limit exceeded' }),
      ].join('\n') },
      stderr: { text: '' },
    }
  })

  const first = await post(handler, '/clickvibe/api/fetch', { url: 'https://github.com/o/r/issues/41' })
  const second = await post(handler, '/clickvibe/api/state', { repoKey: 'o/r' })
  assert.equal(first.status, 429)
  assert.equal(second.status, 429)
  assert.match(first.body.error ?? '', /^GitHub 额度已用完,约 \d{2}:\d{2} 恢复$/)
  assert.equal(second.body.error, first.body.error)
  assert.equal(requests, 1, 'open circuit must reject without another GitHub request')
})

test('repository GitHub aggregation uses its short TTL cache and force refresh bypasses it', async () => {
  const issue = { number: 1, title: 'cached', state: 'open', body: '', html_url: 'https://github.com/o/r/issues/1' }
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const overrides = { config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' }, workflows: [] }

  assert.equal((await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, overrides)).ok, true)
  assert.equal((await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, overrides)).ok, true)
  assert.equal(commands.length, 2)
  assert.equal((await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r', forceRefresh: true }, overrides)).ok, true)
  assert.equal(commands.length, 4)
})

test('repo issue aggregation includes open issues without workflows and honors live merged PR state', async () => {
  const allIssues = [
    { number: 5, title: 'dependency', state: 'closed', body: '', html_url: 'https://github.com/o/r/issues/5', milestone: null },
    { number: 7, title: 'delivered but still open', state: 'open', body: '## 依赖\nBlocked by #5', html_url: 'https://github.com/o/r/issues/7', milestone: { title: 'M1' } },
    { number: 8, title: 'never developed', state: 'open', body: '## 依赖\n无', html_url: 'https://github.com/o/r/issues/8', milestone: null },
  ]
  const prs = [
    { number: 19, state: 'closed', merged_at: '2026-08-22T00:00:00Z', head: { ref: 'r-issue-7' }, html_url: 'https://github.com/o/r/pull/19' },
  ]
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included(allIssues) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included(prs) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
    workflows: [],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const issues = result.issues as Array<{
    number: number
    milestone: { title: string } | null
    blockedBy: { number: number; state: string }[]
    workflow: { prNumber: string | null; derived: { status: string; nextAction: { kind: string; label: string } } }
  }>
  assert.deepEqual(issues.map((issue) => issue.number), [7, 8])
  assert.deepEqual(issues[0].blockedBy, [{ number: 5, title: 'dependency', state: 'CLOSED' }])
  assert.equal(issues[0].milestone?.title, 'M1')
  assert.equal(issues[0].workflow.prNumber, '19')
  assert.equal(issues[0].workflow.derived.status, 'passed')
  assert.equal(issues[0].workflow.derived.nextAction.kind, 'none')
  assert.equal(issues[1].workflow.derived.status, 'idle')
  assert.equal(issues[1].workflow.derived.nextAction.label, '开始开发')
})

test('repo aggregation unlocks closed dependencies with an idempotent comment before rewriting the ledger', async () => {
  const body = '## 目标\n自动开发\n\n## 验收标准\n- [ ] 可启动\n\n## 依赖\nBlocked by #8'
  const issue = { number: 9, title: 'ready after dependency', state: 'open', body, html_url: 'https://github.com/o/r/issues/9', milestone: null }
  const dependency = { number: 8, title: 'done', state: 'closed', body: '', html_url: 'https://github.com/o/r/issues/8', milestone: null }
  const writes: Array<{ command: string; stdin?: string }> = []
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string; stdin?: string }) {
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue, dependency]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/issues/9/comments') && !spec.command.includes('--method')) {
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method POST')) {
          writes.push(spec)
          return { exitCode: 0, stdout: { text: included({ id: 1 }) }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method PATCH')) {
          writes.push(spec)
          return { exitCode: 0, stdout: { text: included({ updated_at: '2026-08-22T08:00:00Z' }) }, stderr: { text: '' } }
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' }, workflows: [],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(writes.length, 2)
  assert.match(writes[0].command, /--method POST/)
  assert.match(writes[0].stdin ?? '', /clickvibe:dependency-unlock:8/)
  assert.match(writes[1].command, /--method PATCH/)
  assert.match(writes[1].stdin ?? '', /依赖: 无\(原 Blocked by #8 已完成，自动更新\)/)
  const unlocked = result.issues.find((candidate) => (candidate as { number: number }).number === 9) as {
    blockedBy: unknown[]
    autoDevelopment: { ready: boolean }
    dependencyLedger: { updated: boolean }
  }
  assert.deepEqual(unlocked.blockedBy, [])
  assert.equal(unlocked.autoDevelopment.ready, true)
  assert.equal(unlocked.dependencyLedger.updated, true)
})

test('repo aggregation keeps a closed issue visible while merged cleanup is pending', async () => {
  const issue = {
    number: 23, title: 'cleanup pending', state: 'closed', body: '',
    html_url: 'https://github.com/o/r/issues/23', milestone: null,
  }
  const workflow = interruptedWorkflow('o-r-23', issue.html_url, '/remote/worktrees/r-issue-23')
  workflow.branch = 'r-issue-23'
  workflow.stage = 'passed'
  workflow.delivery = {
    status: 'cleanup-pending', mergedAt: '2026-08-22T00:00:00Z', prHead: 'abcdef1', mergeStrategy: 'merge',
    cleanup: { worktree: false, localBranch: false, remoteBranch: false, issue: false },
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([
          { number: 29, state: 'closed', merged_at: '2026-08-22T00:00:00Z', head: { ref: workflow.branch }, html_url: 'https://github.com/o/r/pull/29' },
        ]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/29/reviews')) return { exitCode: 0, stdout: { text: included([
          { id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' },
        ]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/29')) return {
          exitCode: 0,
          stdout: { text: included({
            number: 29, state: 'closed', merged_at: '2026-08-22T00:00:00Z',
            head: { ref: workflow.branch, sha: 'abcdef1' }, base: { ref: 'main' }, html_url: 'https://github.com/o/r/pull/29',
          }) }, stderr: { text: '' },
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' }, workflows: [workflow],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const items = result.issues as Array<{ state: string; workflow: { derived: { nextAction: { kind: string } } } }>
  assert.equal(items.length, 1)
  assert.equal(items[0].state, 'CLOSED')
  assert.equal(items[0].workflow.derived.nextAction.kind, 'cleanup')
})

test('repo aggregation consumes snapshot PR facts and skips per-PR detail network calls', async () => {
  // 列表页冷启动优化:PR 已在 pulls?state=all 快照里(含已合并/已关闭)时,
  // 直接消费快照,不再为 workflow 打 pulls/{n}(+reviews) 请求;reviewDecision
  // 等详情留给 /state 后台轮询。fake shell 对 /pulls/29 抛错即证明无网络调用。
  const issue = {
    number: 7, title: 'issue 7', state: 'open', body: '',
    html_url: 'https://github.com/o/r/issues/7', milestone: null,
  }
  const workflow = {
    key: 'o-r-7', url: issue.html_url, repoKey: 'o/r', worktree: '/remote/worktrees/r/r-issue-7', branch: 'r-issue-7',
    stage: 'review-ready', devAgent: 'codex', devTaskId: null, devSessionId: null, devSessionAgent: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null, reviewSessionAgent: null,
    reviewResult: null, prNumber: 29, issueState: 'OPEN',
    baseRef: 'origin/main @ abc', updatedAt: 1, events: [],
  }
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([
          { number: 29, state: 'closed', merged_at: '2026-08-22T00:00:00Z', head: { ref: 'r-issue-7' }, html_url: 'https://github.com/o/r/pull/29' },
        ]) }, stderr: { text: '' } }
        throw new Error('snapshot fast path must not run: ' + spec.command)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
    workflows: [workflow as never],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as { workflow: { prNumber: string; derived: { status: string; nextAction: { kind: string } } } }
  assert.equal(item.workflow.prNumber, '29')
  assert.equal(item.workflow.derived.status, 'passed')
  assert.equal(item.workflow.derived.nextAction.kind, 'none')
  assert.equal(commands.filter((command) => command.startsWith('gh api ')).length, 2, 'only the issues+pulls snapshot, no per-PR detail')
  // #8:列表项携带契约合规字段;空正文 = 缺 目标/验收标准/依赖(选前校验标记,不硬选)
  const contractItem = result.issues[0] as unknown as { contract: { ok: boolean; missing: string[] } }
  assert.equal(contractItem.contract.ok, false)
  assert.deepEqual(contractItem.contract.missing, ['目标', '验收标准', '依赖'])
})
test('repo issue aggregation fails closed when a stored PR cannot be refreshed by number', async () => {
  const issue = { number: 7, title: 'issue 7', state: 'open', body: '', html_url: 'https://github.com/o/r/issues/7', milestone: null }
  const workflow = {
    key: 'o-r-7', url: issue.html_url, repoKey: 'o/r', worktree: '/remote/worktrees/r/r-issue-7', branch: 'renamed-branch',
    stage: 'passed', devAgent: 'codex', devTaskId: null, devSessionId: null, devSessionAgent: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null, reviewSessionAgent: null,
    reviewResult: { passed: true, issues: [] }, prNumber: 99, issueState: 'OPEN',
    baseRef: 'origin/main @ abc', updatedAt: 1, events: [],
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/99')) return { exitCode: 1, stdout: { text: included({ message: 'offline' }, 500) }, stderr: { text: 'offline' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
    workflows: [workflow as never],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as { workflow: { prNumber: string; derived: { nextAction: { kind: string; label: string } } } }
  assert.equal(item.workflow.prNumber, '99')
  assert.deepEqual(item.workflow.derived.nextAction, {
    kind: 'none', label: '刷新 PR 状态', hint: 'GitHub PR 实时状态查询失败,为避免误合并已暂停动作',
  })
})

test('repo issue aggregation refreshes stored PR by number when its head no longer matches', async () => {
  const issue = { number: 7, title: 'issue 7', state: 'open', body: '', html_url: 'https://github.com/o/r/issues/7', milestone: null }
  const workflow = {
    key: 'o-r-7', url: issue.html_url, repoKey: 'o/r', worktree: '/remote/worktrees/r/r-issue-7', branch: 'old-branch-name',
    stage: 'passed', devAgent: 'codex', devTaskId: null, devSessionId: null, devSessionAgent: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null, reviewSessionAgent: null,
    reviewResult: { passed: true, issues: [] }, prNumber: 99, issueState: 'OPEN',
    baseRef: 'origin/main @ abc', updatedAt: 1, events: [],
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/99/reviews')) return { exitCode: 0, stdout: { text: included([{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T01:00:00Z' }]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/99')) return {
          exitCode: 0,
          stdout: { text: included({ number: 99, state: 'closed', merged_at: '2026-08-22T00:00:00Z', head: { ref: 'new-branch-name' }, html_url: 'https://github.com/o/r/pull/99' }) },
          stderr: { text: '' },
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
    workflows: [workflow as never],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as { workflow: { prNumber: string; derived: { status: string; nextAction: { kind: string } } } }
  assert.equal(item.workflow.prNumber, '99')
  assert.equal(item.workflow.derived.status, 'passed')
  assert.equal(item.workflow.derived.nextAction.kind, 'none')
})

test('repo issue aggregation uses unbounded pagination and keeps issues beyond 1000', async () => {
  const allIssues = Array.from({ length: 1001 }, (_, index) => ({
    number: index + 1, title: `issue ${index + 1}`, state: 'open', body: '',
    html_url: `https://github.com/o/r/issues/${index + 1}`, milestone: null,
  }))
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) { return spec },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?')) {
          const page = Number(spec.command.match(/[?&]page=(\d+)/)?.[1] ?? 1)
          return { exitCode: 0, stdout: { text: included(allIssues.slice((page - 1) * 100, page * 100)) }, stderr: { text: '' } }
        }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(ctx as never, { repoKey: 'o/r' }, {
    config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' }, workflows: [],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.issues.length, 1001)
  assert.equal(commands.filter((command) => command.startsWith('gh api ')).length, 12)
})
