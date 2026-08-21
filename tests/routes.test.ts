import assert from 'node:assert/strict'
import { createServer, request, type RequestListener } from 'node:http'
import test from 'node:test'
import { apply } from '../src/index.ts'

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