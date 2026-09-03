import assert from 'node:assert/strict'
import { beforeEach } from 'node:test'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'

beforeEach(() => resetGithubGatewayOwnerForTests())
import { commitWorkflowFixture } from './workflow-fixture.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/index.ts'
import { parseCommand } from '../src/workflow/command.ts'
import { type IssueWorkflow } from '../src/infra/state.ts'
import { fingerprintGithubIssueContract } from '../src/workflow/work-item-contract-repository.ts'
function included(body: unknown, status = 200): string {
  return [`HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}`, '', JSON.stringify(body)].join('\n')
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
    skills: { register: () => () => {} },
    webServer: {
      register(route: { handler: RequestListener }) {
        handler = route.handler
        return () => {}
      },
    },
    // cordis fiber lifecycle api; the gateway close effect is never torn down
    // by this unit harness.
    effect: () => () => {},
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      run:
        run ??
        (() => {
          throw new Error('shell must not run for this request')
        }),
      start:
        start ??
        (() => {
          throw new Error('shell must not start for this request')
        }),
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
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/clickvibe/api/command',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...headers,
            ...(headers.origin === 'same-origin' ? { origin: `http://127.0.0.1:${address.port}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function workflowFixture(key: string, url: string, worktree: string): IssueWorkflow {
  return {
    key,
    url,
    repoKey: 'o/r',
    worktree,
    branch: 'r-issue-23',
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: { passed: true, issues: [] },
    prNumber: '29',
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
}

const PRIVILEGED = { origin: 'same-origin', 'x-clickvibe-request': '1' }

test('help command answers readable text without any shell call', async () => {
  const result = await post(createHandler(), { command: 'help' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.match(String(result.body.text), /develop/)
  assert.match(String(result.body.text), /merge/)
})

test('projects command lists configured repos', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-projects-'))
  process.env.HOME = tempHome
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const repo = await initFixtureRepository(join(tempHome, 'repo'))
  await activateV02Home(tempHome, { 'o/r': repo })

  const result = await post(createHandler(), { command: 'projects' })
  assert.equal(result.status, 200)
  assert.match(String(result.body.text), /已配置的项目/)
  assert.match(String(result.body.text), /o\/r/)
})

test('status command returns readable workflow state derived from the same /state logic', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-status-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    const missingRepo = await initFixtureRepository(join(tempHome, 'missing-repo'))
    await activateV02Home(tempHome, { 'o/r': missingRepo })
    const workflow = workflowFixture('o-r-23', 'https://github.com/o/r/issues/23', join(tempHome, 'missing-worktree'))
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const item = {
      url: workflow.url,
      number: 23,
      title: 'cmd issue',
      body: 'x',
      state: 'OPEN',
      updatedAt: 'now',
      comments: [],
    }
    const handler = createHandler(async ({ command }) => {
      if (command.startsWith('set +e')) {
        return {
          exitCode: 0,
          stdout: {
            text: 'REPO_DEFAULT\t128\t\nREPO_BRANCH\t0\tbWFpbg==\nREPO_HEAD\t128\t\nREPO_MAIN_COUNT\t128\t\nREPO_HEAD_COUNT\t128\t\n',
          },
          stderr: { text: '' },
        }
      }
      const api = githubApi(command, {
        item,
        pr: {
          number: 29,
          state: 'open',
          merged_at: null,
          head: { ref: workflow.branch, sha: 'abc' },
          base: { ref: 'main', sha: '1111111111111111' },
        },
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
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
    const missingRepo = await initFixtureRepository(join(tempHome, 'missing-repo'))
    await activateV02Home(tempHome, { 'o/r': missingRepo })
    await developPreviewScenario()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function developPreviewScenario(): Promise<void> {
  const item = {
    url: 'https://github.com/o/r/issues/13',
    number: 13,
    title: 'command develop',
    body: '## 目标\ncommand develop\n## 验收标准\n- [ ] x\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
    state: 'OPEN',
    updatedAt: '2026-08-23T00:00:00Z',
    comments: [],
  }
  let issueReads = 0
  const handler = createHandler(
    async ({ command }) => {
      if (/\/issues\/13'/.test(command)) issueReads += 1
      const api = githubApi(command, { item })
      if (api) return api
      throw new Error(`unexpected command: ${command}`)
    },
    () => {
      throw new Error('phase 1 must not start an agent')
    },
  )

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
  const tampered = await post(
    handler,
    {
      command: 'develop #13 context=changed after preview',
      authorizationId: authorization.authorizationId,
      authorizationDigest: authorization.authorizationDigest,
    },
    PRIVILEGED,
  )
  assert.equal(tampered.status, 403)
  assert.match(String(tampered.body.error), /授权无效/)
}

test('confirmed develop revalidates the frozen snapshot through the same backend action', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-confirm-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    const missingRepo = await initFixtureRepository(join(tempHome, 'missing-repo'))
    await activateV02Home(tempHome, { 'o/r': missingRepo })
    await confirmedDevelopScenario()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function confirmedDevelopScenario(): Promise<void> {
  const url = 'https://github.com/o/r/issues/14'
  const oldItem = {
    url,
    number: 14,
    title: 'old target',
    body: '## 目标\nold target\n## 验收标准\n- [ ] old acceptance\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
    state: 'OPEN',
    updatedAt: '2026-08-23T05:00:00Z',
    comments: [],
  }
  let issueReads = 0
  const handler = createHandler(
    async ({ command }) => {
      if (/\/issues\/14'/.test(command)) {
        issueReads += 1
        // read1 = 命令解析目标;read2 = 授权签发前的 upstream-confirmed capture;
        // read3 = 确认执行前的 upstream-confirmed capture(此时已变化)。
        const current =
          issueReads <= 2
            ? oldItem
            : {
                ...oldItem,
                body: oldItem.body.replace('old acceptance', 'new acceptance'),
                updatedAt: '2026-08-23T06:00:00Z',
              }
        return githubApi(command, { item: current })
      }
      return githubApi(command, { item: oldItem }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    },
    () => {
      throw new Error('no agent may start when the snapshot changed')
    },
  )

  const preview = await post(handler, { command: 'develop #14' }, PRIVILEGED)
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  const authorization = preview.body.authorization as Record<string, string>
  const confirmed = await post(
    handler,
    {
      command: 'develop #14',
      authorizationId: authorization.authorizationId,
      authorizationDigest: authorization.authorizationDigest,
    },
    PRIVILEGED,
  )
  // startDevelop 在执行前重新拉取 issue:预览后正文变化 → 拒绝,与面板按钮同一门禁
  assert.equal(confirmed.status, 400)
  assert.match(String(confirmed.body.error), /契约在确认后已变化/)
}

test('review command previews through the shared authorize path', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-review-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    const missingRepo = await initFixtureRepository(join(tempHome, 'missing-repo'))
    await activateV02Home(tempHome, { 'o/r': missingRepo })
    const item = {
      url: 'https://github.com/o/r/issues/15',
      number: 15,
      title: 'review target',
      body: 'y',
      state: 'OPEN',
      updatedAt: '2026-08-23T00:00:00Z',
      comments: [],
    }
    const handler = createHandler(
      async ({ command }) => {
        const api = githubApi(command, { item })
        if (api) return api
        throw new Error(`unexpected command: ${command}`)
      },
      () => {
        throw new Error('phase 1 must not start an agent')
      },
    )
    const preview = await post(handler, { command: 'review #15' }, PRIVILEGED)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.needsConfirmation, true)
    assert.match(String(preview.body.text), /review/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('merge command surfaces every gate failure and supports the manual override (issue #49)', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-override-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await initFixtureRepository(repo)
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await activateV02Home(tempHome, { 'o/r': repo }, { worktreeRoot: join(tempHome, 'worktrees') })
    const workflow = workflowFixture(
      'o-r-23',
      'https://github.com/o/r/issues/23',
      join(tempHome, 'worktrees', 'r-issue-23'),
    )
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    const reviewedBody = '## 目标\noverride\n## 验收标准\n- [ ] old\n## 依赖\n无\n## 非目标\n无\n## 约束\n无'
    workflow.events = [
      {
        kind: 'review',
        at: 'now',
        hash: '1111111',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        // 契约也变更:两个门禁同时失败,命令应把清单全量列出
        issueContract: {
          fingerprint: fingerprintGithubIssueContract({ url: workflow.url, body: reviewedBody }),
          capturedAt: '2026-08-22T00:00:00Z',
        },
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const handler = createHandler(
      async ({ command }) => {
        const api = githubApi(command, {
          item: {
            url: workflow.url,
            number: 23,
            title: 'override issue',
            body: reviewedBody.replace('old', 'changed'),
            state: 'OPEN',
            updatedAt: '2026-08-23T00:00:00Z',
          },
          pr: {
            number: 29,
            state: 'open',
            merged_at: null,
            head: { ref: workflow.branch, sha: '2222222222222222' },
            base: { ref: 'main', sha: '1111111111111111' },
          },
        })
        if (api) return api
        throw new Error(`unexpected command: ${command}`)
      },
      () => {
        throw new Error('merge preview must not start an agent')
      },
    )

    const rejected = await post(handler, { command: 'merge #23' }, PRIVILEGED)
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body))
    const failures = rejected.body.gateFailures as { key: string }[]
    assert.deepEqual(
      failures.map((failure) => failure.key),
      ['review-hash', 'contract-changed'],
    )
    assert.match(String(rejected.body.text), /哈希不一致/)
    assert.match(String(rejected.body.text), /验收契约已变更/)
    assert.match(String(rejected.body.text), /merge <目标> override=<放行原因>/)

    // 带放行原因:预览签发跳过项绑定当前实际失败项,文本明示将跳过哪些门禁
    const override = await post(handler, { command: 'merge #23 override=已人工核对,同意放行' }, PRIVILEGED)
    assert.equal(override.status, 200, JSON.stringify(override.body))
    assert.equal(override.body.needsConfirmation, true)
    assert.match(String(override.body.text), /人工放行/)
    assert.match(String(override.body.text), /PR base:main @ 1111111111111111/)
    assert.match(String(override.body.text), /已人工核对,同意放行/)
    const authorization = override.body.authorization as Record<string, unknown>
    assert.ok(authorization.authorizationId)
    assert.ok((authorization.override as { skipped: string[] }).skipped.includes('review-hash'))

    const misplaced = parseCommand('develop #8 override=理由')
    assert.equal(misplaced.ok, false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('unknown repos and unparsable commands answer actionable errors', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-errors-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    const one = await initFixtureRepository(join(tempHome, 'one'))
    const two = await initFixtureRepository(join(tempHome, 'two'))
    await activateV02Home(tempHome, { 'a/one': one, 'b/two': two })
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
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
