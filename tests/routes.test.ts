import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, fetchRepositoryIssues } from '../src/index.ts'
import {
  appendLog,
  loadAllArchivedWorkflows,
  loadWorkflow,
  readLogHistory,
  saveWorkflow,
  type IssueWorkflow,
} from '../src/state.ts'

function createHandler(
  run?: (spec: { command: string; workdir?: string; stdin?: string }) => Promise<unknown>,
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
  const handler = createHandler(async (spec) => ({
    exitCode: 0,
    stdout: { text: spec.command.startsWith('gh issue view') ? JSON.stringify(item) : '[]' },
    stderr: { text: '' },
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
    workflow.events = [{
      kind: 'review', at: '2026-08-22T00:00:00Z', hash: 'abcdef1',
      verdict: { passed: true, issues: [] },
    }]
    await saveWorkflow(workflow)

    let merged = false
    let issueClosed = false
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (spec.command.startsWith('gh pr view')) return {
        exitCode: 0,
        stdout: { text: JSON.stringify({
          number: 29, state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? '2026-08-22T01:00:00Z' : null,
          headRefName: workflow.branch, headRefOid: 'abcdef1234567890', baseRefName: 'main',
          url: 'https://github.com/o/r/pull/29', reviewDecision: 'APPROVED',
        }) }, stderr: { text: '' },
      }
      if (spec.command.startsWith('gh pr merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: 'merged' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git show-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git ls-remote')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue view')) return { exitCode: 0, stdout: { text: issueClosed ? 'CLOSED' : 'OPEN' }, stderr: { text: '' } }
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
      if (spec.command.startsWith('gh pr view')) return {
        exitCode: 0,
        stdout: { text: JSON.stringify({
          number: 29, state: 'OPEN', mergedAt: null, headRefName: workflow.branch,
          headRefOid: '2222222222222222', baseRefName: 'main', url: 'https://github.com/o/r/pull/29', reviewDecision: 'APPROVED',
        }) }, stderr: { text: '' },
      }
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
    workflow.events = [{ kind: 'review', at: 'now', hash: 'abcdef1', verdict: { passed: true, issues: [] } }]
    await saveWorkflow(workflow)

    let merged = false
    let removeAttempts = 0
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (spec.command.startsWith('gh pr view')) return {
        exitCode: 0,
        stdout: { text: JSON.stringify({
          number: 29, state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? '2026-08-22T01:00:00Z' : null,
          headRefName: workflow.branch, headRefOid: 'abcdef1234567890', baseRefName: 'main',
          url: 'https://github.com/o/r/pull/29', reviewDecision: 'APPROVED',
        }) }, stderr: { text: '' },
      }
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
      if (spec.command.startsWith('gh issue view')) return { exitCode: 0, stdout: { text: 'CLOSED' }, stderr: { text: '' } }
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
      if (spec.command.startsWith('gh pr view')) return {
        exitCode: 0,
        stdout: { text: JSON.stringify({
          number: 29, state: 'OPEN', mergedAt: null, headRefName: workflow.branch,
          headRefOid: 'abcdef1234567890', baseRefName: 'main', url: 'https://github.com/o/r/pull/29', reviewDecision: null,
        }) }, stderr: { text: '' },
      }
      if (spec.command.startsWith('gh issue view')) return { exitCode: 0, stdout: { text: 'CLOSED' }, stderr: { text: '' } }
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
      if (command.startsWith('gh issue view')) return { exitCode: 0, stdout: { text: JSON.stringify(issue) }, stderr: { text: '' } }
      if (command.startsWith('gh api') || command.startsWith('gh issue list')) return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
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
    const starts: Array<{ command: string; workdir?: string }> = []
    const comments: Array<{ command: string; body: string }> = []
    const handler = createHandler(async (spec) => {
      if (spec.command.startsWith('gh issue view')) return { exitCode: 0, stdout: { text: JSON.stringify({
        url: workflow.url, title: 'resume issue', body: '## 验收标准\n- fallback', state: 'OPEN', updatedAt: 'now', comments: [],
      }) }, stderr: { text: '' } }
      if (spec.command.startsWith('gh api') || spec.command.startsWith('gh issue list')) {
        return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
      }
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/pull/29#issuecomment-1' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      starts.push({ command: spec.command, workdir: spec.workdir })
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
    assert.match(starts[0].command, /exec resume 'dead-session'/)
    assert.equal(starts[1].command, 'codex exec -c approval_policy=never -s danger-full-access --json -')
    assert.deepEqual(starts.map((start) => start.workdir), [worktree, worktree])
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
    const handler = createHandler(async (spec) => {
      if (spec.command === 'git rev-parse --short HEAD') {
        return { exitCode: 0, stdout: { text: 'def4567' }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('gh pr list')) {
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/issues/920#issuecomment-3' }, stderr: { text: '' } }
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
    const starts: string[] = []
    const comments: Array<{ command: string; body: string }> = []
    const handler = createHandler(async (spec) => {
      if (spec.command.startsWith('gh pr view')) return { exitCode: 0, stdout: { text: 'main' }, stderr: { text: '' } }
      if (spec.command === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (spec.command.startsWith('gh issue comment')) {
        comments.push({ command: spec.command, body: spec.stdin ?? '' })
        return { exitCode: 0, stdout: { text: 'https://github.com/o/r/pull/29#issuecomment-2' }, stderr: { text: '' } }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }, (spec) => {
      starts.push(spec.command)
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
    assert.match(starts[0], /exec resume 'dead-review'/)
    assert.equal(starts[1], 'codex exec -c approval_policy=never -s danger-full-access --json -')
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.reviewSessionId, 'new-review')
    assert.equal(reloaded?.reviewSessionAgent, 'codex')
    assert.equal(reloaded?.reviewResult?.passed, true)
    assert.ok(completed.delta.some((line) => line.includes('review 结束,退出码 0')))
    assert.ok(completed.delta.some((line) => line.includes('review 结论来源')))
    assert.equal(reloaded?.reviewResult?.commentUrl, 'https://github.com/o/r/pull/29#issuecomment-2')
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /github\.com\/o\/r\/pull\/29/)
    assert.match(comments[0].body, /^== Review Meta ==\n- event: review\n- commit: abc123\n- issue: #918\n- passed: true\n- next: merge/m)
    assert.match(comments[0].body, /下一步:可合并当前提交。/)
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
    const handler = createHandler(async (spec) => {
      if (spec.command.startsWith('gh pr view')) return { exitCode: 0, stdout: { text: 'main' }, stderr: { text: '' } }
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
    if (spec.command.startsWith('gh issue view')) {
      return { exitCode: 0, stdout: { text: JSON.stringify(item) }, stderr: { text: '' } }
    }
    if (spec.command.startsWith('gh issue list')) {
      return { exitCode: 0, stdout: { text: JSON.stringify(issues) }, stderr: { text: '' } }
    }
    return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
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
    if (spec.command.startsWith('gh issue view')) {
      return { exitCode: 0, stdout: { text: JSON.stringify(item) }, stderr: { text: '' } }
    }
    if (spec.command.startsWith('gh issue list')) {
      return { exitCode: 0, stdout: { text: JSON.stringify(issues) }, stderr: { text: '' } }
    }
    return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
  })
  const result = await post(handler, '/clickvibe/api/fetch', { url: item.url })
  assert.equal(result.status, 200)
  const deps = (result.body as { ok: true; data: { dependencies?: { blockedBy: unknown[]; blocking: unknown[] } } }).data.dependencies
  assert.ok(deps)
  assert.deepEqual(deps.blockedBy, [])
  assert.deepEqual(deps.blocking.map((d) => (d as { number: number }).number), [7])
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
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: JSON.stringify([allIssues]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: JSON.stringify([prs]) }, stderr: { text: '' } }
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
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: JSON.stringify([[issue]]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: JSON.stringify([[
          { number: 29, state: 'closed', merged_at: '2026-08-22T00:00:00Z', head: { ref: workflow.branch }, html_url: 'https://github.com/o/r/pull/29' },
        ]]) }, stderr: { text: '' } }
        if (spec.command.startsWith('gh pr view')) return {
          exitCode: 0,
          stdout: { text: JSON.stringify({
            number: 29, state: 'MERGED', mergedAt: '2026-08-22T00:00:00Z', headRefName: workflow.branch,
            headRefOid: 'abcdef1', baseRefName: 'main', url: 'https://github.com/o/r/pull/29', reviewDecision: 'APPROVED',
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
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: JSON.stringify([[issue]]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: '[[]]' }, stderr: { text: '' } }
        if (spec.command.startsWith('gh pr view')) return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline' } }
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
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: JSON.stringify([[issue]]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: '[[]]' }, stderr: { text: '' } }
        if (spec.command.startsWith("gh pr view '99'")) return {
          exitCode: 0,
          stdout: { text: JSON.stringify({ number: 99, state: 'MERGED', mergedAt: '2026-08-22T00:00:00Z', headRefName: 'new-branch-name', url: 'https://github.com/o/r/pull/99', reviewDecision: 'APPROVED' }) },
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
        if (spec.command.includes('/issues?')) return { exitCode: 0, stdout: { text: JSON.stringify([allIssues.slice(0, 1000), allIssues.slice(1000)]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?')) return { exitCode: 0, stdout: { text: '[[]]' }, stderr: { text: '' } }
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
  assert.equal(commands.filter((command) => command.includes('--paginate --slurp')).length, 2)
})
