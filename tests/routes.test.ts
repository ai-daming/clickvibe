import assert from 'node:assert/strict'
import { createServer, request, type RequestListener } from 'node:http'
import test from 'node:test'
import { apply, fetchRepositoryIssues } from '../src/index.ts'

function createHandler(run?: (spec: { command: string }) => Promise<unknown>): RequestListener {
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
      start() { throw new Error('shell must not run for rejected requests') },
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

test('/projects route returns the configured-project envelope without invoking shell', async () => {
  const result = await post(createHandler(), '/clickvibe/api/projects', {})
  assert.equal(result.status, 200)
  assert.equal(Array.isArray((result.body as { projects?: unknown[] }).projects), true)
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

test('repo issue aggregation fails closed when a stored PR cannot be refreshed by number', async () => {
  const issue = { number: 7, title: 'issue 7', state: 'open', body: '', html_url: 'https://github.com/o/r/issues/7', milestone: null }
  const workflow = {
    key: 'o-r-7', url: issue.html_url, repoKey: 'o/r', worktree: '/remote/worktrees/r/r-issue-7', branch: 'renamed-branch',
    stage: 'passed', devAgent: 'codex', devTaskId: null, devSessionId: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null,
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
    stage: 'passed', devAgent: 'codex', devTaskId: null, devSessionId: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null,
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
