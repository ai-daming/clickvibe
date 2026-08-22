import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/index.ts'
import { parseCommand } from '../src/command.ts'
import { saveWorkflow, type IssueWorkflow } from '../src/state.ts'

function included(body: unknown, status = 200): string {
  return [
    `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}`,
    '',
    JSON.stringify(body),
  ].join('\n')
}

function restIssue(item: Record<string, unknown>): Record<string, unknown> {
  const url = String(item.url ?? '')
  return {
    ...item,
    html_url: url,
    state: String(item.state ?? 'open').toLowerCase(),
    user: item.author ?? { login: 'owner' },
    created_at: item.createdAt ?? '',
    updated_at: item.updatedAt ?? '',
  }
}

function githubApi(
  command: string,
  options: {
    item?: Record<string, unknown>
    pr?: Record<string, unknown>
  } = {},
): { exitCode: number; stdout: { text: string }; stderr: { text: string } } | null {
  if (!command.startsWith('gh api ')) return null
  let body: unknown = []
  if (/\/issues\/\d+\/comments/.test(command) || /\/issues\/\d+\/timeline/.test(command)) {
    body = []
  } else if (/\/pulls\/\d+\/reviews/.test(command) || /\/pulls\/\d+\/requested_reviewers/.test(command)) {
    body = []
  } else if (/\/pulls\?/.test(command)) {
    body = []
  } else if (/\/pulls\/\d+/.test(command)) {
    body = options.pr ?? {}
  } else if (/\/issues\/\d+/.test(command)) {
    body = restIssue(options.item ?? {})
  } else if (/\/issues\?state=all/.test(command)) {
    body = options.item ? [restIssue(options.item)] : []
  }
  return { exitCode: 0, stdout: { text: included(body) }, stderr: { text: '' } }
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
      run: run ?? (() => { throw new Error('shell must not run for this request') }),
      start: start ?? (() => { throw new Error('shell must not start for this request') }),
    },
  }
  apply(ctx as never)
  assert.ok(handler)
  return handler
}

async function post(
  listener: RequestListener,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = request({
        host: '127.0.0.1', port: address.port, path: '/clickvibe/api/command', method: 'POST',
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
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function workflowFixture(key: string, url: string, worktree: string): IssueWorkflow {
  return {
    key, url, repoKey: 'o/r', worktree, branch: 'r-issue-23', stage: 'review-ready',
    devAgent: 'codex', devTaskId: null, devSessionId: null, devSessionAgent: null, devInterrupted: false,
    reviewAgent: 'codex', reviewTaskId: null, reviewSessionId: null, reviewSessionAgent: null,
    reviewResult: { passed: true, issues: [] }, prNumber: '29', issueState: 'OPEN',
    baseRef: 'origin/main @ abc', updatedAt: 1, events: [],
  }
}

const PRIVILEGED = { origin: 'same-origin', 'x-clickvibe-request': '1' }

test('parseCommand understands the canonical Chinese phrasing and strict grammar', () => {
  const canonical = parseCommand('把 #8 下单开发')
  assert.ok(canonical.ok)
  assert.equal(canonical.command.action, 'develop')
  assert.equal(canonical.command.number, '8')
  assert.equal(canonical.command.agent, null)

  const glued = parseCommand('把#8下单开发')
  assert.ok(glued.ok)
  assert.equal(glued.command.action, 'develop')
  assert.equal(glued.command.number, '8')

  const full = parseCommand('develop 8 ai-daming/clickvibe agent=claude')
  assert.ok(full.ok)
  assert.deepEqual(
    [full.command.action, full.command.number, full.command.repoKey, full.command.agent],
    ['develop', '8', 'ai-daming/clickvibe', 'claude'],
  )

  const dryrun = parseCommand('安全演练 #8')
  assert.ok(dryrun.ok)
  assert.equal(dryrun.command.action, 'develop')
  assert.equal(dryrun.command.agent, 'dryrun')

  const rework = parseCommand('rework #8 context=先修 A 再补测试')
  assert.ok(rework.ok)
  assert.equal(rework.command.action, 'rework')
  assert.equal(rework.command.context, '先修 A 再补测试')

  const urlStatus = parseCommand('status https://github.com/o/r/issues/23')
  assert.ok(urlStatus.ok)
  assert.equal(urlStatus.command.action, 'status')
  assert.equal(urlStatus.command.url, 'https://github.com/o/r/issues/23')

  const prReview = parseCommand('用 claude review https://github.com/o/r/pull/41')
  assert.ok(prReview.ok)
  assert.equal(prReview.command.action, 'review')
  assert.equal(prReview.command.agent, 'claude')

  for (const bad of ['', 'foo bar', 'develop', 'develop #8 agent=gpt', 'develop #8 context=']) {
    const rejected = parseCommand(bad)
    assert.equal(rejected.ok, false, `"${bad}" must be rejected`)
  }
})

test('help command answers readable text without any shell call', async () => {
  const result = await post(createHandler(), { command: 'help' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.match(String(result.body.text), /develop/)
  assert.match(String(result.body.text), /merge/)
})

test('projects command lists configured repos', async () => {
  const result = await post(createHandler(), { command: 'projects' })
  assert.equal(result.status, 200)
  assert.match(String(result.body.text), /已配置的项目/)
})

test('status command returns readable workflow state derived from the same /state logic', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-status-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${join(tempHome, 'missing-repo')}\n`)
    const workflow = workflowFixture('o-r-23', 'https://github.com/o/r/issues/23', join(tempHome, 'missing-worktree'))
    await saveWorkflow(workflow)
    const item = { url: workflow.url, number: 23, title: 'cmd issue', body: 'x', state: 'OPEN', updatedAt: 'now', comments: [] }
    const handler = createHandler(async ({ command }) => {
      const api = githubApi(command, {
        item,
        pr: { number: 29, state: 'open', merged_at: null, head: { ref: workflow.branch, sha: 'abc' }, base: { ref: 'main' } },
      })
      if (api) return api
      throw new Error(`unexpected command: ${command}`)
    })

    const status = await post(handler, { command: 'status #23' })
    assert.equal(status.status, 200, JSON.stringify(status.body))
    // worktree 缺失时权威状态退化为「待 review + 结论过期 + 下一步:检查本地配置」
    assert.match(String(status.body.text), /#23 · 待 review/)
    assert.match(String(status.body.text), /分支:r-issue-23/)
    assert.match(String(status.body.text), /PR:#29/)
    assert.match(String(status.body.text), /下一步:无 —— worktree 缺失/)

    const missing = await post(handler, { command: 'status https://github.com/o/r/issues/99' })
    assert.equal(missing.status, 200)
    assert.match(String(missing.body.text), /还没有 ClickVibe workflow/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('write commands refuse to even preview without the privileged headers', async () => {
  const result = await post(createHandler(), { command: 'develop #1' })
  assert.equal(result.status, 403)
  assert.match(String(result.body.error), /授权请求头/)
})

test('develop command previews with a one-use authorization instead of starting an agent', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-preview-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${join(tempHome, 'missing-repo')}\n`)
    await developPreviewScenario()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

async function developPreviewScenario(): Promise<void> {
  const item = {
    url: 'https://github.com/o/r/issues/13', number: 13, title: 'command develop',
    body: '## 验收标准\n- x', state: 'OPEN', updatedAt: '2026-08-23T00:00:00Z', comments: [],
  }
  let issueReads = 0
  const handler = createHandler(async ({ command }) => {
    if (/\/issues\/13'/.test(command)) issueReads += 1
    const api = githubApi(command, { item })
    if (api) return api
    throw new Error(`unexpected command: ${command}`)
  }, () => { throw new Error('phase 1 must not start an agent') })

  const preview = await post(handler, { command: '把 #13 下单开发' }, PRIVILEGED)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.needsConfirmation, true)
  assert.match(String(preview.body.text), /codex 开发/)
  assert.match(String(preview.body.text), /command develop/)
  assert.match(String(preview.body.text), /请用户在对话中明确确认/)
  const authorization = preview.body.authorization as Record<string, unknown>
  assert.ok(authorization.authorizationId)
  assert.ok(authorization.authorizationDigest)

  // 授权是消费型的:篡改 context 后重发,必须被同一 consumeAuthorization 拒绝
  const tampered = await post(handler, {
    command: 'develop #13 context=changed after preview',
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
  }, PRIVILEGED)
  assert.equal(tampered.status, 403)
  assert.match(String(tampered.body.error), /授权无效/)
}

test('confirmed develop revalidates the frozen snapshot through the same backend action', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-confirm-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${join(tempHome, 'missing-repo')}\n`)
    await confirmedDevelopScenario()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

async function confirmedDevelopScenario(): Promise<void> {
  const url = 'https://github.com/o/r/issues/14'
  const oldItem = {
    url, number: 14, title: 'old target', body: 'old acceptance', state: 'OPEN',
    updatedAt: '2026-08-23T05:00:00Z', comments: [],
  }
  let issueReads = 0
  const handler = createHandler(async ({ command }) => {
    if (/\/issues\/14'/.test(command)) {
      issueReads += 1
      // read1 = 命令预览时的强制刷新;read2 = 确认执行前的快照复验(此时已变化)
      const current = issueReads === 1 ? oldItem : { ...oldItem, body: 'new acceptance', updatedAt: '2026-08-23T06:00:00Z' }
      return githubApi(command, { item: current })
    }
    return githubApi(command, { item: oldItem }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }, () => { throw new Error('no agent may start when the snapshot changed') })

  const preview = await post(handler, { command: 'develop #14' }, PRIVILEGED)
  assert.equal(preview.status, 200)
  const authorization = preview.body.authorization as Record<string, string>
  const confirmed = await post(handler, {
    command: 'develop #14',
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
  }, PRIVILEGED)
  // startDevelop 在执行前重新拉取 issue:预览后正文变化 → 拒绝,与面板按钮同一门禁
  assert.equal(confirmed.status, 400)
  assert.match(String(confirmed.body.error), /内容在确认后已变化/)
}

test('review command previews through the shared authorize path', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-review-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${join(tempHome, 'missing-repo')}\n`)
    const item = {
      url: 'https://github.com/o/r/issues/15', number: 15, title: 'review target',
      body: 'y', state: 'OPEN', updatedAt: '2026-08-23T00:00:00Z', comments: [],
    }
    const handler = createHandler(async ({ command }) => {
      const api = githubApi(command, { item })
      if (api) return api
      throw new Error(`unexpected command: ${command}`)
    }, () => { throw new Error('phase 1 must not start an agent') })
    const preview = await post(handler, { command: 'review #15' }, PRIVILEGED)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.needsConfirmation, true)
    assert.match(String(preview.body.text), /review/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('unknown repos and unparsable commands answer actionable errors', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-errors-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), 'repos:\n  a/one: /x\n  b/two: /y\n')
    const ambiguous = await post(createHandler(), { command: 'develop #8' }, PRIVILEGED)
    assert.equal(ambiguous.status, 400)
    assert.match(String(ambiguous.body.error), /多个项目/)

    const unknown = await post(createHandler(), { command: 'develop #8 no/such' }, PRIVILEGED)
    assert.equal(unknown.status, 400)
    assert.match(String(unknown.body.error), /未配置项目/)

    const garbage = await post(createHandler(), { command: '开饭 #8' })
    assert.equal(garbage.status, 400)
    assert.match(String(garbage.body.error), /无法识别/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
