import assert from 'node:assert/strict'
import { beforeEach } from 'node:test'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { closeRemoteGitCoordinator, resetRemoteGitCoordinatorForTests } from '../src/infra/remote-git.ts'

beforeEach(async () => {
  resetGithubGatewayOwnerForTests()
  resetRemoteGitCoordinatorForTests()
  await rm(join(routesTestHome, '.clickvibe', 'state', 'work-items'), { recursive: true, force: true })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { waitForTaskPersistence } from '../src/agent/task-supervisor.ts'
import { apply, fetchRepositoryIssues } from '../src/index.ts'
import { decodeLiveLogLine, encodeLiveLogEvent } from '../src/infra/live-output.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import {
  appendLog,
  appendTaskLog,
  type IssueWorkflow,
  loadAllArchivedWorkflows,
  loadWorkflow,
  readLogHistory,
  startTaskLog,
} from '../src/infra/state.ts'
import { createFakeJobs } from './fake-jobs.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'
import { fingerprintGithubIssueContract } from '../src/workflow/work-item-contract-repository.ts'
import { workItemContractPaths } from '../src/infra/work-item-contract-store.ts'
import { readDiagnosticRecords } from '../src/infra/diagnostic-record.ts'

// Route tests exercise /state background reconciliation; never let that controller
// discover or mutate the developer's real ~/.clickvibe workflow files.
const routesOriginalHome = process.env.HOME
const routesTestHome = await mkdtemp(join(tmpdir(), 'clickvibe-routes-home-'))
process.env.HOME = routesTestHome
after(async () => {
  if (routesOriginalHome === undefined) delete process.env.HOME
  else process.env.HOME = routesOriginalHome
  await rm(routesTestHome, { recursive: true, force: true })
})

const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

function contractBody(goal: string, acceptance = goal): string {
  return `## 目标\n${goal}\n## 验收标准\n- [ ] ${acceptance}\n## 依赖\n无\n## 非目标\n无\n## 约束\n无`
}

function contractRef(url: string, body: string, capturedAt: string) {
  return { fingerprint: fingerprintGithubIssueContract({ url, body }), capturedAt }
}

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
  // Mutations are writes (slice B): the shared GET helper never answers them —
  // each test's write branches (PUT merge / POST comment / PATCH state) own them.
  if (!command.startsWith('gh api ') || command.includes('--method')) return null
  let body: unknown = []
  let exitCode = 0
  let stderr = ''
  if (/\/issues\?state=all/.test(command)) {
    if (options.failRepoIssues) {
      return {
        exitCode: 1,
        stdout: { text: included({ message: options.failRepoIssues }, 500) },
        stderr: { text: options.failRepoIssues },
      }
    }
    body = (options.issues ?? []).map(restIssue)
  } else if (/\/pulls\?state=all/.test(command)) {
    body = options.pulls ?? []
  } else if (/\/issues\/\d+\/comments/.test(command)) {
    const commandNumber = command.match(/\/issues\/(\d+)\/comments/)?.[1]
    const itemNumber = String(
      options.item?.number ?? String(options.item?.url ?? '').match(/\/issues\/(\d+)/)?.[1] ?? '',
    )
    const comments =
      commandNumber === itemNumber
        ? Array.isArray(options.item?.comments)
          ? (options.item.comments as Array<Record<string, unknown>>)
          : []
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
    jobs: createFakeJobs(),
    skills: { register: () => () => {} },
    webServer: {
      register(route: { handler: RequestListener }) {
        handler = route.handler
        return () => {}
      },
    },
    // cordis fiber lifecycle api: the gateway close effect registers here and
    // is torn down with the plugin (never invoked by this unit harness).
    effect: () => () => {},
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      run:
        run ??
        (() => {
          throw new Error('shell must not run for rejected requests')
        }),
      start:
        start ??
        (() => {
          throw new Error('shell must not run for rejected requests')
        }),
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
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
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
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; error?: string },
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
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        )
      })
        .on('error', reject)
        .end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

test('/develop rejects a real agent before any shell command without server authorization', async () => {
  const result = await post(createHandler(), '/clickvibe/api/develop', {
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
    agent: 'codex',
  })
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /授权请求头/)
})

test('/auto authorization binds the frozen issue and all five configuration values', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/74',
    number: 74,
    title: 'Auto delivery',
    body: contractBody('ship', 'done'),
    state: 'OPEN',
    updatedAt: '2026-08-23T13:31:14Z',
    comments: [],
  }
  const handler = createHandler(async (spec) => {
    const response = githubApi(spec.command, { item })
    if (response) return response
    throw new Error(`unexpected command: ${spec.command}`)
  })
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const expectedSnapshot = {
    url: item.url,
    title: item.title,
    body: item.body,
    state: item.state,
    updatedAt: item.updatedAt,
    comments: [],
  }
  const autoRun = {
    autoMerge: false,
    devAgent: 'codex',
    reviewAgent: 'claude',
    maxRounds: 20,
    budgetHours: 24,
  }
  const preview = (await post(
    handler,
    '/clickvibe/api/authorize',
    { action: 'auto', url: item.url, autoRun, expectedSnapshot },
    headers,
  )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
  assert.equal(preview.status, 200)
  const tampered = await post(
    handler,
    '/clickvibe/api/auto',
    {
      url: item.url,
      autoRun: { ...autoRun, autoMerge: true },
      authorizationId: preview.body.authorizationId,
      authorizationDigest: preview.body.authorizationDigest,
    },
    headers,
  )
  assert.equal(tampered.status, 403)
  assert.match(tampered.body.error ?? '', /授权无效/)
  const replay = await post(
    handler,
    '/clickvibe/api/auto',
    {
      url: item.url,
      autoRun,
      authorizationId: preview.body.authorizationId,
      authorizationDigest: preview.body.authorizationDigest,
    },
    headers,
  )
  assert.equal(replay.status, 403)
})

test('/clickvibe auto command previews the five settings through the shared backend action', async () => {
  const item = {
    url: 'https://github.com/o/r/issues/74',
    number: 74,
    title: 'auto command',
    body: contractBody('ship', 'done'),
    state: 'OPEN',
    updatedAt: '2026-08-23T13:31:14Z',
    comments: [],
  }
  const handler = createHandler(async (spec) => {
    const response = githubApi(spec.command, { item })
    if (response) return response
    throw new Error(`unexpected command: ${spec.command}`)
  })
  const preview = (await post(
    handler,
    '/clickvibe/api/command',
    {
      command: `/clickvibe auto ${item.url} dev=claude review=codex rounds=7 budget=12 merge=on`,
    },
    { origin: 'same-origin', 'x-clickvibe-request': '1' },
  )) as { status: number; body: Record<string, unknown> }
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.needsConfirmation, true)
  assert.match(String(preview.body.text), /开发 agent:claude · Review agent:codex/)
  assert.match(String(preview.body.text), /轮次上限:7 · 总预算:12 小时/)
  assert.match(String(preview.body.text), /自动合并:开/)
})

test('/create-pr uses a one-use privileged authorization before the shared handler', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-create-pr-auth-'))
  process.env.HOME = tempHome
  try {
    const handler = createHandler()
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const url = 'https://github.com/ai-daming/clickvibe/issues/74'
    const preview = (await post(handler, '/clickvibe/api/authorize', { action: 'create-pr', url }, headers)) as {
      status: number
      body: { authorizationId?: string; authorizationDigest?: string }
    }
    assert.equal(preview.status, 200)
    const first = await post(
      handler,
      '/clickvibe/api/create-pr',
      {
        url,
        authorizationId: preview.body.authorizationId,
        authorizationDigest: preview.body.authorizationDigest,
      },
      headers,
    )
    assert.equal(first.status, 400)
    assert.match(first.body.error ?? '', /workflow/)
    const replay = await post(
      handler,
      '/clickvibe/api/create-pr',
      {
        url,
        authorizationId: preview.body.authorizationId,
        authorizationDigest: preview.body.authorizationDigest,
      },
      headers,
    )
    assert.equal(replay.status, 403)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/create-pr recovers a pending PR-create marker by readback and never re-creates', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-create-pr-recover-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-74', 'https://github.com/o/r/issues/74', worktree)
    workflow.prCreate = { status: 'pending', at: '2026-08-22T00:00:00Z' }
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    let writes = 0
    const issue = {
      url: workflow.url,
      number: 74,
      title: 'recover PR',
      body: contractBody('recover PR'),
      state: 'OPEN',
      updatedAt: '2026-09-03T00:00:00Z',
      comments: [],
    }
    const handler = createHandler(async (spec) => {
      if (spec.command.includes('/pulls?state=open')) {
        return {
          exitCode: 0,
          stdout: { text: included([{ number: 31, head: { ref: workflow.branch } }]) },
          stderr: { text: '' },
        }
      }
      const api = githubApi(spec.command, { item: issue })
      if (api) return api
      if (spec.command.includes('--method')) {
        writes += 1
        throw new Error(`unexpected write: ${spec.command}`)
      }
      return { exitCode: 0, stdout: { text: included({}) }, stderr: { text: '' } }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const preview = (await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'create-pr', url: workflow.url },
      headers,
    )) as {
      status: number
      body: { authorizationId?: string; authorizationDigest?: string }
    }
    assert.equal(preview.status, 200)
    const result = (await post(
      handler,
      '/clickvibe/api/create-pr',
      {
        url: workflow.url,
        authorizationId: preview.body.authorizationId,
        authorizationDigest: preview.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok?: boolean; prNumber?: string; created?: boolean; error?: string } }
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.prNumber, '31')
    assert.equal(result.body.created, false)
    assert.equal(writes, 0, 'pending marker recovery settles by readback, never a second create')
    const reloaded = await loadWorkflow('o-r-74')
    assert.equal(reloaded?.prNumber, '31')
    assert.equal(reloaded?.prCreate, undefined, 'the marker is resolved once the PR is adopted')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/authorize rejects cross-origin requests before fetching issue content', async () => {
  const result = await post(
    createHandler(),
    '/clickvibe/api/authorize',
    {
      action: 'develop',
      url: 'https://github.com/ai-daming/clickvibe/issues/1',
      agent: 'codex',
    },
    {
      origin: 'https://evil.example',
      'x-clickvibe-request': '1',
    },
  )
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /跨站/)
})

test('authorization route freezes the displayed snapshot and consumes tampered capabilities', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
    title: 'snapshot title',
    body: contractBody('snapshot body'),
    state: 'OPEN',
    updatedAt: '2026-08-21T00:00:00Z',
    comments: [{ author: { login: 'owner' }, body: 'review note' }],
  }
  const handler = createHandler(
    async (spec) =>
      githubApi(spec.command, { item }) ?? {
        exitCode: 0,
        stdout: { text: '' },
        stderr: { text: '' },
      },
  )
  const expectedSnapshot = {
    url: item.url,
    title: item.title,
    body: item.body,
    state: item.state,
    updatedAt: item.updatedAt,
    comments: [{ author: 'owner', body: 'review note' }],
  }
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const authorized = (await post(
    handler,
    '/clickvibe/api/authorize',
    {
      action: 'develop',
      url: item.url,
      agent: 'codex',
      context: '',
      expectedSnapshot,
    },
    headers,
  )) as { status: number; body: { ok: boolean; authorizationId?: string; authorizationDigest?: string } }
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
  assert.equal(authorized.body.ok, true)

  const tampered = await post(
    handler,
    '/clickvibe/api/develop',
    {
      url: item.url,
      agent: 'codex',
      context: 'changed after confirmation',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    },
    headers,
  )
  assert.equal(tampered.status, 403)
  assert.match(tampered.body.error ?? '', /授权无效/)

  const replay = await post(
    handler,
    '/clickvibe/api/develop',
    {
      url: item.url,
      agent: 'codex',
      context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    },
    headers,
  )
  assert.equal(replay.status, 403)
})

test('develop authorization previews fetched baselines and binds a custom selection', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-preview-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), ['repos:', `  o/r: ${repo}`, ''].join('\n'))
    const item = {
      url: 'https://github.com/o/r/issues/60',
      title: 'baseline selection',
      body: contractBody('select release'),
      state: 'OPEN',
      updatedAt: '2026-08-23T00:00:00Z',
      comments: [],
    }
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, { item })
      if (api) return api
      if (spec.command === 'git fetch origin --prune')
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
        return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
      if (spec.command.startsWith('git for-each-ref'))
        return {
          exitCode: 0,
          stdout: { text: 'origin/HEAD\norigin/main\norigin/release/2.0\norigin/clickvibe-issue-17\n' },
          stderr: { text: '' },
        }
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const expectedSnapshot = { ...item }
    const authorized = await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'develop', url: item.url, agent: 'codex', baseline: 'origin/release/2.0', expectedSnapshot },
      headers,
    )
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
    assert.deepEqual((authorized.body.preview as { baselineOptions: string[] }).baselineOptions, [
      'origin/HEAD',
      'origin/clickvibe-issue-17',
      'origin/main',
      'origin/release/2.0',
    ])
    assert.equal((authorized.body.preview as { baseline: string }).baseline, 'origin/release/2.0')
    assert.equal((authorized.body.preview as { baselineFrozen: boolean }).baselineFrozen, false)
    assert.equal(commands.includes('git fetch origin --prune'), true)

    const dependencyPreview = await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'develop', url: item.url, agent: 'codex', baseline: 'origin/clickvibe-issue-17', expectedSnapshot },
      headers,
    )
    assert.equal(dependencyPreview.status, 200, JSON.stringify(dependencyPreview.body))
    assert.equal((dependencyPreview.body.preview as { baselineDependencyIssue: number }).baselineDependencyIssue, 17)

    const missingPreview = await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'develop', url: item.url, agent: 'codex', baseline: 'origin/not-fetched', expectedSnapshot },
      headers,
    )
    assert.equal(missingPreview.status, 400)
    assert.match(String(missingPreview.body.error), /不存在或未 fetch/)

    const tampered = await post(
      handler,
      '/clickvibe/api/develop',
      {
        url: item.url,
        agent: 'codex',
        baseline: 'origin/main',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )
    assert.equal(tampered.status, 403)

    const frozen = interruptedWorkflow('o-r-60', item.url, join(tempHome, 'worktree'))
    frozen.baseRef = 'origin/release/2.0 @ abc123'
    await saveWorkflow(frozen)
    const frozenPreview = await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'develop', url: item.url, agent: 'codex', expectedSnapshot },
      headers,
    )
    assert.equal(frozenPreview.status, 200, JSON.stringify(frozenPreview.body))
    assert.equal((frozenPreview.body.preview as { baselineFrozen: boolean }).baselineFrozen, true)
    assert.equal((frozenPreview.body.preview as { baselineRef: string }).baselineRef, frozen.baseRef)
    assert.deepEqual((frozenPreview.body.preview as { baselineOptions: string[] }).baselineOptions, [
      'origin/release/2.0',
    ])
    const replaceFrozen = await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'develop', url: item.url, agent: 'codex', baseline: 'origin/main', expectedSnapshot },
      headers,
    )
    assert.equal(replaceFrozen.status, 400)
    assert.match(String(replaceFrozen.body.error), /基线已定格/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('concurrent first-development authorizations freeze exactly one baseline and start one task', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-race-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(tempHome, 'worktrees')}`, ''].join('\n'),
    )
    const item = {
      url: 'https://github.com/o/r/issues/601',
      title: 'baseline race',
      body: contractBody('freeze once'),
      state: 'OPEN',
      updatedAt: '2026-08-23T00:00:00Z',
      comments: [],
    }
    let developmentPhase = false
    let fetchArrivals = 0
    let releaseFetches: (() => void) | null = null
    const bothFetchesArrived = new Promise<void>((resolve) => {
      releaseFetches = resolve
    })
    let starts = 0
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, { item })
        if (api) return api
        if (spec.command === 'git fetch origin --prune') {
          if (developmentPhase) {
            fetchArrivals += 1
            if (fetchArrivals === 2) releaseFetches?.()
            await Promise.race([bothFetchesArrived, new Promise((resolve) => setTimeout(resolve, 50))])
          }
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
          return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
        if (spec.command.startsWith('git for-each-ref'))
          return {
            exitCode: 0,
            stdout: { text: 'origin/HEAD\norigin/main\norigin/release/2.0\n' },
            stderr: { text: '' },
          }
        if (spec.command.startsWith('git show-ref --verify --quiet') && spec.command.includes('refs/remotes/'))
          return { exitCode: 0, stdout: { text: '0' }, stderr: { text: '' } }
        if (spec.command.startsWith('git rev-parse --short')) {
          const hash = spec.command.includes('release/2.0')
            ? '2222222'
            : spec.command.includes('HEAD')
              ? '3333333'
              : '1111111'
          return { exitCode: 0, stdout: { text: hash }, stderr: { text: '' } }
        }
        if (spec.command === 'git worktree list --porcelain')
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (spec.command.startsWith('git show-ref --verify --quiet') && spec.command.includes('refs/heads/'))
          return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
        if (spec.command.startsWith('git worktree add'))
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          item.comments.push({ author: { login: 'clickvibe' }, body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":1}' }, stderr: { text: '' } }
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
      () => {
        starts += 1
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 100)),
          readOutput() {
            return { delta: '', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = async (baseline: string) =>
      (await post(
        handler,
        '/clickvibe/api/authorize',
        { action: 'develop', url: item.url, agent: 'codex', baseline, expectedSnapshot: item },
        headers,
      )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const main = await authorize('origin/main')
    const release = await authorize('origin/release/2.0')
    assert.equal(main.status, 200)
    assert.equal(release.status, 200)
    developmentPhase = true

    const develop = (baseline: string, authorization: typeof main) =>
      post(
        handler,
        '/clickvibe/api/develop',
        {
          url: item.url,
          agent: 'codex',
          baseline,
          authorizationId: authorization.body.authorizationId,
          authorizationDigest: authorization.body.authorizationDigest,
        },
        headers,
      )
    const results = await Promise.all([develop('origin/main', main), develop('origin/release/2.0', release)])
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400])
    assert.equal(starts, 1)
    assert.match(results.find((result) => result.status === 400)?.body.error ?? '', /基线已定格/)
    const frozen = await loadWorkflow('o-r-601')
    assert.match(frozen?.baseRef ?? '', /^origin\/(?:main|release\/2\.0) @ (?:1111111|2222222)$/)
    await new Promise((resolve) => setTimeout(resolve, 120))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('development rejects a confirmed snapshot when the issue changes before stage start', async () => {
  const url = 'https://github.com/ai-daming/clickvibe/issues/20'
  const oldItem = {
    url,
    title: 'old target',
    body: '## 目标\nold target\n## 验收标准\n- [ ] old acceptance\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
    state: 'OPEN',
    updatedAt: '2026-08-22T05:00:00Z',
    comments: [],
  }
  let issueReads = 0
  const handler = createHandler(async (spec) => {
    if (/gh api .*\/issues\/20'/.test(spec.command)) {
      issueReads += 1
      const current =
        issueReads === 1
          ? oldItem
          : {
              ...oldItem,
              body: oldItem.body.replace('old acceptance', 'new acceptance'),
              updatedAt: '2026-08-22T06:00:00Z',
            }
      return githubApi(spec.command, { item: current })
    }
    return githubApi(spec.command, { item: oldItem }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const authorized = (await post(
    handler,
    '/clickvibe/api/authorize',
    {
      action: 'develop',
      url,
      agent: 'codex',
      context: '',
      expectedSnapshot: oldItem,
    },
    headers,
  )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
  assert.equal(authorized.status, 200)
  const developed = await post(
    handler,
    '/clickvibe/api/develop',
    {
      url,
      agent: 'codex',
      context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    },
    headers,
  )
  assert.equal(developed.status, 400)
  assert.match(developed.body.error ?? '', /契约在确认后已变化/)
  assert.equal(issueReads, 2)
})

test('an unknown current contract version issues zero authorization and preserves diagnostic evidence', async () => {
  const url = 'https://github.com/ai-daming/clickvibe/issues/22'
  const item = {
    url,
    title: 'future contract',
    body: contractBody('ship safely'),
    state: 'OPEN',
    updatedAt: '2026-09-03T02:00:00Z',
    comments: [],
  }
  const handler = createHandler(async (spec) => {
    return githubApi(spec.command, { item }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const observed = await post(handler, '/clickvibe/api/fetch', { url })
  assert.equal(observed.status, 200)
  const root = join(routesTestHome, '.clickvibe', 'state')
  const workItem = { provider: 'github', instance: 'github.com', container: 'ai-daming/clickvibe', id: '22' }
  const paths = workItemContractPaths(root, workItem)
  await writeFile(
    paths.current,
    `${JSON.stringify({ schemaVersion: 2, captureId: 'capture2_future', fingerprint: 'wic2_future' })}\n`,
  )

  const authorized = await post(
    handler,
    '/clickvibe/api/authorize',
    { action: 'develop', url, agent: 'codex', expectedSnapshot: item },
    { origin: 'same-origin', 'x-clickvibe-request': '1' },
  )
  assert.equal(authorized.status, 400)
  assert.equal((authorized.body as { authorizationId?: string }).authorizationId, undefined)
  assert.match(authorized.body.error ?? '', /当前契约|unknown-current-version/)
  const diagnostics = await readDiagnosticRecords(root, workItem)
  assert.ok(diagnostics.some((record) => record.message.includes('unknown-current-version')))
})

test('development authorization survives title comments checkbox and updatedAt changes', async () => {
  const url = 'https://github.com/ai-daming/clickvibe/issues/21'
  const body = '## 目标\nship\n## 验收标准\n- [ ] done\n## 依赖\n无\n## 非目标\n无\n## 约束\n无'
  const oldItem = { url, title: 'old title', body, state: 'OPEN', updatedAt: '2026-09-03T01:00:00Z', comments: [] }
  let issueReads = 0
  const handler = createHandler(async (spec) => {
    if (/gh api .*\/issues\/21'/.test(spec.command)) {
      issueReads += 1
      const current =
        issueReads === 1
          ? oldItem
          : {
              ...oldItem,
              title: 'new title',
              body: body.replace('- [ ] done', '- [x] done'),
              updatedAt: '2026-09-03T01:01:00Z',
              comments: [{ author: { login: 'bot' }, body: 'diagnostic evidence' }],
            }
      return githubApi(spec.command, { item: current })
    }
    return githubApi(spec.command, { item: oldItem }) ?? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  })
  const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
  const authorized = (await post(
    handler,
    '/clickvibe/api/authorize',
    { action: 'develop', url, agent: 'codex', context: '', expectedSnapshot: oldItem },
    headers,
  )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
  const developed = await post(
    handler,
    '/clickvibe/api/develop',
    {
      url,
      agent: 'codex',
      context: '',
      authorizationId: authorized.body.authorizationId,
      authorizationDigest: authorized.body.authorizationDigest,
    },
    headers,
  )
  assert.doesNotMatch(developed.body.error ?? '', /授权|契约.*变化/)
  assert.equal(issueReads, 2)
})

test('/sync rejects worktree mutation without the same-origin privileged headers', async () => {
  const result = await post(createHandler(), '/clickvibe/api/sync', {
    url: 'https://github.com/ai-daming/clickvibe/issues/1',
  })
  assert.equal(result.status, 403)
  assert.match(result.body.error ?? '', /授权请求头/)
})

test('missing baseline restoration requires and consumes an exact one-use authorization', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-restore-route-'))
  process.env.HOME = home
  try {
    const firstHash = 'a'.repeat(40)
    const secondHash = 'd'.repeat(40)
    const repo = join(home, 'repo')
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(home, 'worktrees')}`, ''].join('\n'),
    )
    const workflow = {
      key: 'o-r-60',
      url: 'https://github.com/o/r/issues/60',
      repoKey: 'o/r',
      worktree: join(home, 'worktrees', 'repo', 'repo-issue-60'),
      branch: 'repo-issue-60',
      stage: 'review-ready',
      devAgent: 'codex',
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: null,
      reviewTaskId: null,
      reviewSessionId: null,
      reviewSessionAgent: null,
      reviewResult: null,
      prNumber: null,
      issueState: 'OPEN',
      baseRef: `origin/release/deleted @ ${firstHash}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await saveWorkflow(workflow)
    const commands: string[] = []
    let pushed = false
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (spec.command.includes('refs/remotes/origin/release/deleted')) {
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'missing' } }
      }
      if (spec.command.startsWith('git rev-parse --verify')) {
        return { exitCode: 0, stdout: { text: secondHash }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('git push ')) pushed = true
      if (spec.command.startsWith('git ls-remote --heads')) {
        return {
          exitCode: 0,
          stdout: { text: pushed ? `${secondHash}\trefs/heads/release/deleted\n` : '' },
          stderr: { text: '' },
        }
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const unauthorized = await post(handler, '/clickvibe/api/sync', { url: workflow.url, restoreBase: true }, headers)
    assert.equal(unauthorized.status, 403)
    assert.equal(commands.length, 0)

    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'restore-base', url: workflow.url },
      headers,
    )) as {
      status: number
      body: {
        authorizationId: string
        authorizationDigest: string
        restoreTarget: { branch: string; hash: string }
        preview: { baseline: string; baselineRef: string }
      }
    }
    assert.equal(authorized.status, 200)
    assert.equal(authorized.body.preview.baseline, 'origin/release/deleted')
    assert.equal(authorized.body.preview.baselineRef, firstHash)
    assert.deepEqual(authorized.body.restoreTarget, { branch: 'release/deleted', hash: firstHash })
    workflow.baseRef = `origin/release/deleted @ ${secondHash}`
    await saveWorkflow(workflow)
    const stale = await post(
      handler,
      '/clickvibe/api/sync',
      {
        url: workflow.url,
        restoreBase: true,
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
        restoreTarget: authorized.body.restoreTarget,
      },
      headers,
    )
    assert.equal(stale.status, 400)
    assert.equal(
      commands.some((command) => command.startsWith('git push --force-with-lease=')),
      false,
    )

    const refreshed = (await post(
      handler,
      '/clickvibe/api/authorize',
      { action: 'restore-base', url: workflow.url },
      headers,
    )) as typeof authorized
    assert.deepEqual(refreshed.body.restoreTarget, { branch: 'release/deleted', hash: secondHash })
    const restored = await post(
      handler,
      '/clickvibe/api/sync',
      {
        url: workflow.url,
        restoreBase: true,
        authorizationId: refreshed.body.authorizationId,
        authorizationDigest: refreshed.body.authorizationDigest,
        restoreTarget: refreshed.body.restoreTarget,
      },
      headers,
    )
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.ok(commands.some((command) => command.startsWith('git push --force-with-lease=')))
    const replay = await post(
      handler,
      '/clickvibe/api/sync',
      {
        url: workflow.url,
        restoreBase: true,
        authorizationId: refreshed.body.authorizationId,
        authorizationDigest: refreshed.body.authorizationDigest,
        restoreTarget: refreshed.body.restoreTarget,
      },
      headers,
    )
    assert.equal(replay.status, 403)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('all privileged workflow routes reject missing request provenance before action dispatch', async () => {
  for (const method of ['review', 'resume', 'stop', 'sync', 'merge']) {
    const result = await post(createHandler(), `/clickvibe/api/${method}`, {
      url: 'https://github.com/o/r/issues/1',
      agent: 'codex',
    })
    assert.equal(result.status, 403, method)
    assert.match(result.body.error ?? '', /授权请求头/, method)
  }
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
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', worktree)
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    workflow.autoRun = {
      status: 'running',
      autoMerge: true,
      devAgent: 'codex',
      reviewAgent: 'claude',
      maxRounds: 20,
      budgetHours: 24,
      startedAt: '2026-08-22T00:00:00Z',
      deadline: '2026-08-23T00:00:00Z',
      rounds: 1,
      unresolved: [],
      lastObservedAt: null,
      pausedReason: null,
    }
    const reviewedBody = contractBody('merge contract')
    workflow.events = [
      {
        kind: 'review',
        at: '2026-08-22T00:00:00Z',
        hash: 'abcdef1',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        issueContract: contractRef(workflow.url, reviewedBody, '2026-08-22T00:00:00Z'),
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)

    let merged = false
    let issueClosed = false
    const commands: string[] = []
    const writeBodies: string[] = []
    const closeComments: Array<{ body: string }> = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (spec.command.includes('--method PUT') && spec.command.includes('/merge')) writeBodies.push(spec.stdin ?? '')
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'merge issue',
          body: reviewedBody,
          state: issueClosed ? 'CLOSED' : 'OPEN',
          comments: closeComments,
          updatedAt: '2026-08-22T00:00:00Z',
        },
        pr: {
          number: 29,
          state: merged ? 'closed' : 'open',
          merged_at: merged ? '2026-08-22T01:00:00Z' : null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890abcdef1234567890abcdef12' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      if (spec.command.includes('--method PUT') && spec.command.includes('/merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"merged":true}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
        closeComments.push({ body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":77}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method PATCH') && spec.command.includes('/issues/')) {
        issueClosed = true
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"state":"closed"}' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain')
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git show-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('git ls-remote --heads'))
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }

      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
      },
      headers,
    )) as {
      status: number
      body: {
        ok: boolean
        authorizationId?: string
        authorizationDigest?: string
        target?: { prNumber: string; branch: string; head: string; mergeFlag: string }
        preview?: { prNumber: string; branch: string; head: string; mergeFlag: string; cleanup: string[] }
      }
    }
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
    assert.deepEqual(authorized.body.preview, {
      prNumber: '29',
      branch: workflow.branch,
      head: 'abcdef1234567890abcdef1234567890abcdef12',
      baseRef: 'main',
      baseSha: '1111111111111111',
      mergeFlag: '--merge',
      cleanup: ['worktree', '本地分支', '远端分支', 'Issue #23', 'workflow 归档'],
    })

    const tampered = await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
        target: { ...authorized.body.target, head: 'fffffffffffffff' },
      },
      headers,
    )
    assert.equal(tampered.status, 403)
    assert.equal(
      commands.some((command) => command.includes('/merge') && command.includes('--method PUT')),
      false,
    )
    const executionAuthorization = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
      },
      headers,
    )) as typeof authorized
    assert.equal(executionAuthorization.status, 200)

    const response = (await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: executionAuthorization.body.authorizationId,
        authorizationDigest: executionAuthorization.body.authorizationDigest,
        target: executionAuthorization.body.target,
      },
      headers,
    )) as { status: number; body: { ok: boolean; archived?: boolean } }
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.archived, true)
    const mergeCommand =
      commands.find((command) => command.includes('/merge') && command.includes('--method PUT')) ?? ''
    assert.match(mergeCommand, /repos\/o\/r\/pulls\/29\/merge/)
    const mergeBody = JSON.parse(writeBodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(mergeBody.merge_method, 'merge', 'merge commit strategy, not squash/rebase')
    assert.equal(
      mergeBody.sha,
      'abcdef1234567890abcdef1234567890abcdef12',
      'the head CAS pins the exact reviewed commit',
    )
    assert.equal(mergeBody.commit_message, 'Closes #23')
    // The closing comment is its own confirmed write transaction: exactly one
    // POST with the exact body, proven by the comments readback.
    assert.equal(closeComments.length, 1)
    assert.equal(closeComments[0].body, '由 PR #29 以 merge commit 合并交付。')
    assert.equal(await loadWorkflow(workflow.key), null)
    const archived = await loadAllArchivedWorkflows()
    assert.equal(archived.length, 1)
    assert.equal(archived[0].delivery?.status, 'archived')
    assert.equal(archived[0].autoRun?.status, 'completed')
    assert.equal(
      archived[0].events.some((event) => event.kind === 'auto-run' && /自动合并.*收敛/.test(event.note ?? '')),
      true,
    )
    assert.deepEqual(archived[0].delivery?.cleanup, {
      worktree: true,
      localBranch: true,
      remoteBranch: true,
      issue: true,
      issueComment: 'confirmed',
    })

    const replay = await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: executionAuthorization.body.authorizationId,
        authorizationDigest: executionAuthorization.body.authorizationDigest,
        target: executionAuthorization.body.target,
      },
      headers,
    )
    assert.equal(replay.status, 403)
  } finally {
    await closeRemoteGitCoordinator()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/merge rejects a stale review hash before invoking the merge write', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-stale-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', join(worktreeRoot, 'r-issue-23'))
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    workflow.events = [
      {
        kind: 'review',
        at: 'now',
        hash: '1111111',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        pr: {
          number: 29,
          state: 'open',
          merged_at: null,
          head: { ref: workflow.branch, sha: '2222222222222222222222222222222222222222' },
          base: { ref: 'main', sha: '1111111111111111' },
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
    assert.equal(
      commands.some((command) => command.includes('/merge') && command.includes('--method PUT')),
      false,
    )
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
    workflow.events = [
      {
        kind: 'review',
        at: 'now',
        hash: 'abcdef1',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        issueContract: {
          ...contractRef(workflow.url, contractBody('reviewed contract'), '2026-08-22T00:00:00Z'),
        },
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'changed issue',
          body: contractBody('changed contract'),
          state: 'OPEN',
          updatedAt: '2026-08-22T01:00:00Z',
        },
        pr: {
          number: 29,
          state: 'open',
          merged_at: null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890abcdef1234567890abcdef12' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const result = await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
      },
      { origin: 'same-origin', 'x-clickvibe-request': '1' },
    )
    assert.equal(result.status, 400)
    assert.match(result.body.error ?? '', /验收契约已变更.*重新 Review/)
    assert.equal(
      commands.some((command) => command.includes('/merge') && command.includes('--method PUT')),
      false,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/merge gate rejection offers manual override that merges once and audits the timeline', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-merge-override-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    const worktree = join(worktreeRoot, 'r-issue-23')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', worktree)
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    const reviewedBody = contractBody('override contract')
    workflow.events = [
      {
        kind: 'review',
        at: '2026-08-22T00:00:00Z',
        hash: '1111111',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        issueContract: contractRef(workflow.url, reviewedBody, '2026-08-22T00:00:00Z'),
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)

    let merged = false
    let issueClosed = false
    const commands: string[] = []
    const writeBodies: string[] = []
    const closeComments: Array<{ body: string }> = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (spec.command.includes('--method PUT') && spec.command.includes('/merge')) writeBodies.push(spec.stdin ?? '')
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'override issue',
          body: reviewedBody,
          state: issueClosed ? 'CLOSED' : 'OPEN',
          updatedAt: '2026-08-22T00:00:00Z',
          comments: closeComments,
        },
        pr: {
          number: 29,
          state: merged ? 'closed' : 'open',
          merged_at: merged ? '2026-08-22T01:00:00Z' : null,
          head: { ref: workflow.branch, sha: '2222222222222222222222222222222222222222' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      if (spec.command.includes('--method PUT') && spec.command.includes('/merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"merged":true}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
        closeComments.push({ body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":77}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method PATCH') && spec.command.includes('/issues/')) {
        issueClosed = true
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"state":"closed"}' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain')
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('if git show-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (spec.command.startsWith('git ls-remote --heads'))
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }

      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }

    // 1) 门禁拒绝:错误文案不变,同时返回可放行的门禁清单
    const rejected = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
      },
      headers,
    )) as {
      status: number
      body: { ok: boolean; error?: string; gateFailures?: Array<{ key: string; message: string }> }
    }
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.error ?? '', /合并门禁拒绝.*哈希不一致/)
    assert.deepEqual(
      (rejected.body.gateFailures ?? []).map((failure) => failure.key),
      ['review-hash'],
    )

    // 2) 人工放行授权:绑定被跳过的门禁项与原因,预览列出明细
    const overrideReason = '人工确认该提交可合并'
    const overrideAuthorize = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
        override: true,
        overrideReason,
      },
      headers,
    )) as {
      status: number
      body: {
        ok: boolean
        authorizationId?: string
        authorizationDigest?: string
        target?: { prNumber: string; branch: string; head: string; mergeFlag: string }
        override?: { skipped: string[]; reason: string }
        preview?: { override?: { skipped: string[]; reason: string; gates: Array<{ key: string; message: string }> } }
      }
    }
    assert.equal(overrideAuthorize.status, 200, JSON.stringify(overrideAuthorize.body))
    assert.deepEqual(overrideAuthorize.body.override, { skipped: ['review-hash'], reason: overrideReason })
    assert.equal(overrideAuthorize.body.preview?.override?.gates.length, 1)
    assert.equal(
      commands.some((command) => command.includes('/merge') && command.includes('--method PUT')),
      false,
    )

    // 3) 带放行执行合并:成功且写入审计事件
    const mergedResponse = (await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: overrideAuthorize.body.authorizationId,
        authorizationDigest: overrideAuthorize.body.authorizationDigest,
        target: overrideAuthorize.body.target,
        override: overrideAuthorize.body.override,
      },
      headers,
    )) as { status: number; body: { ok: boolean; archived?: boolean } }
    assert.equal(mergedResponse.status, 200, JSON.stringify(mergedResponse.body))
    assert.equal(mergedResponse.body.archived, true)
    const mergeCommand =
      commands.find((command) => command.includes('/merge') && command.includes('--method PUT')) ?? ''
    assert.match(mergeCommand, /repos\/o\/r\/pulls\/29\/merge/)
    assert.equal(
      (JSON.parse(writeBodies[0] ?? '{}') as { sha?: string }).sha,
      '2222222222222222222222222222222222222222',
      'the head CAS pins the exact reviewed commit',
    )
    assert.equal(await loadWorkflow(workflow.key), null)
    const archivedWorkflows = await loadAllArchivedWorkflows()
    assert.equal(archivedWorkflows.length, 1)
    const audit = (archivedWorkflows[0].events ?? []).filter((event) => event.kind === 'merge-override')
    assert.equal(audit.length, 1)
    assert.deepEqual(audit[0].skipped, ['review-hash'])
    assert.deepEqual(audit[0].skippedLabels, ['PR HEAD 与 review 结论哈希不一致'])
    assert.equal(audit[0].reason, overrideReason)
    assert.ok(typeof audit[0].operator === 'string' && audit[0].operator !== '')
    assert.ok(typeof audit[0].at === 'string' && audit[0].at !== '')

    // 4) 放行授权单次有效:重放拒绝
    const replay = await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: overrideAuthorize.body.authorizationId,
        authorizationDigest: overrideAuthorize.body.authorizationDigest,
        target: overrideAuthorize.body.target,
        override: overrideAuthorize.body.override,
      },
      headers,
    )
    assert.equal(replay.status, 403)
  } finally {
    await closeRemoteGitCoordinator()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/merge manual override refuses gate failures not covered by the confirmation', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-override-stale-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', join(worktreeRoot, 'r-issue-23'))
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    workflow.events = [
      {
        kind: 'review',
        at: 'now',
        hash: 'abcdef1',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        issueContract: {
          ...contractRef(workflow.url, contractBody('reviewed contract'), '2026-08-22T00:00:00Z'),
        },
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    // 授权时:哈希一致、契约已变更 → 只放行 contract-changed;
    // 合并时:Issue 契约读取失败(合并路径强制刷新)→ 新增 contract-unreadable
    // 失败项,未被确认覆盖 → 拒绝,且不写放行审计。
    let issueReadFailing = false
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      if (issueReadFailing && /\/issues\/23'/.test(spec.command)) {
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'issue read failed' } }
      }
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'changed issue',
          body: contractBody('changed contract'),
          state: 'OPEN',
          updatedAt: '2026-08-22T01:00:00Z',
        },
        pr: {
          number: 29,
          state: 'open',
          merged_at: null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890abcdef1234567890abcdef12' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const overrideAuthorize = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'merge',
        url: workflow.url,
        override: true,
        overrideReason: '契约改动无关紧要',
      },
      headers,
    )) as {
      status: number
      body: { authorizationId?: string; authorizationDigest?: string; target?: unknown; override?: unknown }
    }
    assert.equal(overrideAuthorize.status, 200, JSON.stringify(overrideAuthorize.body))
    assert.deepEqual((overrideAuthorize.body.override as { skipped: string[] } | undefined)?.skipped, [
      'contract-changed',
    ])

    issueReadFailing = true
    const response = (await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: overrideAuthorize.body.authorizationId,
        authorizationDigest: overrideAuthorize.body.authorizationDigest,
        target: overrideAuthorize.body.target,
        override: overrideAuthorize.body.override,
      },
      headers,
    )) as { status: number; body: { ok: boolean; error?: string } }
    assert.equal(response.status, 400)
    assert.match(response.body.error ?? '', /无法读取当前验收契约.*请重新确认/)
    assert.equal(
      commands.some((command) => command.includes('/merge') && command.includes('--method PUT')),
      false,
    )
    const persisted = await loadWorkflow(workflow.key)
    assert.equal(
      (persisted?.events ?? []).some((event) => event.kind === 'merge-override'),
      false,
    )
    assert.equal(persisted?.delivery, undefined)
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
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  o/r: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const workflow = interruptedWorkflow('o-r-23', 'https://github.com/o/r/issues/23', worktree)
    workflow.branch = 'r-issue-23'
    workflow.stage = 'passed'
    workflow.reviewResult = { passed: true, issues: [] }
    const reviewedBody = contractBody('retry cleanup contract')
    workflow.events = [
      {
        kind: 'review',
        at: 'now',
        hash: 'abcdef1',
        verdict: { passed: true, issues: [] },
        reviewBase: { ref: 'main', sha: '1111111111111111' },
        issueContract: contractRef(workflow.url, reviewedBody, '2026-08-22T00:00:00Z'),
      },
    ]
    await commitWorkflowFixture(workflow, workflow.revision ?? null)

    let merged = false
    let removeAttempts = 0
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'merge issue',
          body: reviewedBody,
          state: 'CLOSED',
          updatedAt: '2026-08-22T00:00:00Z',
        },
        pr: {
          number: 29,
          state: merged ? 'closed' : 'open',
          merged_at: merged ? '2026-08-22T01:00:00Z' : null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890abcdef1234567890abcdef12' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
        reviews: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' }],
      })
      if (api) return api
      if (spec.command.includes('--method PUT') && spec.command.includes('/merge')) {
        merged = true
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"merged":true}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":78}' }, stderr: { text: '' } }
      }
      if (spec.command.includes('--method PATCH') && spec.command.includes('/issues/')) {
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"state":"closed"}' }, stderr: { text: '' } }
      }
      if (spec.command === 'git worktree list --porcelain')
        return {
          exitCode: 0,
          stdout: { text: removeAttempts === 0 ? `worktree ${worktree}\nbranch refs/heads/${workflow.branch}\n` : '' },
          stderr: { text: '' },
        }
      if (spec.command.startsWith('git worktree remove')) {
        removeAttempts++
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'worktree contains changes' } }
      }
      if (spec.command.startsWith('if git show-ref') || spec.command.startsWith('git ls-remote --heads')) {
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      }
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = () =>
      post(handler, '/clickvibe/api/authorize', { action: 'merge', url: workflow.url }, headers) as Promise<{
        status: number
        body: {
          authorizationId?: string
          authorizationDigest?: string
          target?: { prNumber: string; branch: string; head: string; mergeFlag: string }
        }
      }>
    const firstAuthorization = await authorize()
    const first = await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: firstAuthorization.body.authorizationId,
        authorizationDigest: firstAuthorization.body.authorizationDigest,
        target: firstAuthorization.body.target,
      },
      headers,
    )
    assert.equal(first.status, 400)
    assert.match(first.body.error ?? '', /PR 已合并;移除 worktree失败,可重试/)
    const pending = await loadWorkflow(workflow.key)
    assert.equal(pending?.delivery?.status, 'cleanup-pending')
    assert.equal(pending?.delivery?.cleanup.worktree, false)

    const secondAuthorization = await authorize()
    assert.equal(secondAuthorization.status, 200)
    const second = await post(
      handler,
      '/clickvibe/api/merge',
      {
        url: workflow.url,
        authorizationId: secondAuthorization.body.authorizationId,
        authorizationDigest: secondAuthorization.body.authorizationDigest,
        target: secondAuthorization.body.target,
      },
      headers,
    )
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(commands.filter((command) => command.includes('/merge') && command.includes('--method PUT')).length, 1)
    assert.equal((await loadAllArchivedWorkflows())[0]?.delivery?.status, 'archived')
  } finally {
    await closeRemoteGitCoordinator()
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
    const workflow = interruptedWorkflow(
      'o-r-23',
      'https://github.com/o/r/issues/23',
      join(tempHome, 'missing-worktree'),
    )
    workflow.issueState = 'OPEN'
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const handler = createHandler(async (spec) => {
      const api = githubApi(spec.command, {
        item: {
          url: workflow.url,
          number: 23,
          title: 'closed issue',
          body: contractBody('closed issue'),
          state: 'CLOSED',
          updatedAt: '2026-09-03T00:00:00Z',
        },
        pr: {
          number: 29,
          state: 'open',
          merged_at: null,
          head: { ref: workflow.branch, sha: 'abcdef1234567890abcdef1234567890abcdef12' },
          base: { ref: 'main', sha: '1111111111111111' },
          html_url: 'https://github.com/o/r/pull/29',
        },
      })
      if (api) return api
      throw new Error(`unexpected command: ${spec.command}`)
    })
    const response = (await post(handler, '/clickvibe/api/state', { url: workflow.url })) as {
      status: number
      body: { workflows?: Array<{ issueState: string; derived: { nextAction: { kind: string } } }> }
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
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, 'fetchTtlSeconds: 45', ''].join('\n'),
    )
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
      if (command.startsWith('set +e') && command.includes('ENUM_GITDIR')) {
        const enc = (value: string) => Buffer.from(value, 'utf8').toString('base64')
        const line = (key: string, rc: number, value: string) => `${key}\t${rc}\t${enc(value)}`
        return {
          exitCode: 0,
          stdout: {
            text: [
              line('ENUM_GITDIR', 0, '.'),
              line('ENUM_HEAD', 0, 'abc1234'),
              line('ENUM_DEFAULT', 0, 'origin/main'),
              line('ENUM_REFS', 0, ''),
              line('ENUM_BASE_AVAILABLE', 0, '0'),
              line('ENUM_COUNTS', 0, ''),
            ].join('\n'),
          },
          stderr: { text: '' },
        }
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
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), ['repos:', `  o/r: ${repo}`, ''].join('\n'))
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
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', '  remote/only: /path/not/on/this/host', ''].join('\n'),
    )
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
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), ['repos:', `  hanging/repo: ${repo}`, ''].join('\n'))
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
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${worktreeRoot}`, ''].join('\n'),
    )
    await appendLog('o-r-905', 'dev', 'previous completed task history')

    const issue = {
      url: 'https://github.com/o/r/issues/905',
      title: 'conflicting worktree',
      body: contractBody('dryrun conflict'),
      state: 'OPEN',
      updatedAt: 'now',
      comments: [],
    }
    const handler = createHandler(async ({ command }) => {
      const api = githubApi(command, { item: issue })
      if (api) return api
      if (command === 'git fetch origin --prune') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (command.startsWith('git for-each-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
        return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
      if (command === "git rev-parse --short 'origin/main'")
        return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
      if (command === "git show-ref --verify --quiet 'refs/remotes/origin/main'; echo $?")
        return { exitCode: 0, stdout: { text: '0' }, stderr: { text: '' } }
      if (command === 'git worktree list --porcelain')
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      if (command.includes("git show-ref --verify --quiet 'refs/heads/repo-issue-905'"))
        return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
      throw new Error(`unexpected command: ${command}`)
    })

    const result = await post(handler, '/clickvibe/api/develop', {
      url: issue.url,
      agent: 'dryrun',
      baseline: 'origin/release/must-be-ignored',
    })
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

test('dryrun uses the default baseline, reports command output and closes success or failure tasks', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dryrun-execution-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${worktreeRoot}`, ''].join('\n'),
    )
    const runOne = async (number: number, failPwd: boolean) => {
      const issue = {
        url: `https://github.com/o/r/issues/${number}`,
        title: 'dryrun execution',
        body: contractBody('dryrun'),
        state: 'OPEN',
        updatedAt: 'now',
        comments: [],
      }
      const commands: string[] = []
      const handler = createHandler(async ({ command }) => {
        commands.push(command)
        const api = githubApi(command, { item: issue })
        if (api) return api
        if (command === 'git fetch origin --prune') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (command.startsWith('git for-each-ref')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
          return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
        if (command === "git show-ref --verify --quiet 'refs/remotes/origin/main'; echo $?")
          return { exitCode: 0, stdout: { text: '0' }, stderr: { text: '' } }
        if (command === "git rev-parse --short 'origin/main'")
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (command === 'git worktree list --porcelain')
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (command.includes(`refs/heads/repo-issue-${number}`))
          return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
        if (command.startsWith('git worktree add')) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (command === 'pwd')
          return failPwd
            ? { exitCode: 1, stdout: { text: '' }, stderr: { text: 'pwd failed' } }
            : { exitCode: 0, stdout: { text: '/fake/worktree\n' }, stderr: { text: '' } }
        if (command === 'git branch --show-current')
          return { exitCode: 0, stdout: { text: `repo-issue-${number}\n` }, stderr: { text: '' } }
        if (command === 'git status --short --branch')
          return { exitCode: 0, stdout: { text: `## repo-issue-${number}\n` }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${command}`)
      })
      const started = (await post(handler, '/clickvibe/api/develop', {
        url: issue.url,
        agent: 'dryrun',
        baseline: 'origin/release/must-be-ignored',
      })) as { status: number; body: { taskId?: string } }
      assert.equal(started.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const polled = (await post(handler, '/clickvibe/api/develop/poll', {
        taskId: started.body.taskId,
        cursor: 0,
      })) as { body: { status?: string; delta?: string[] } }
      return { commands, polled: polled.body }
    }

    const success = await runOne(906, false)
    assert.equal(success.polled.status, 'done')
    assert.match(success.polled.delta?.join('\n') ?? '', /fake\/worktree.*repo-issue-906/s)
    assert.equal(
      success.commands.some((command) => command.includes('release/must-be-ignored')),
      false,
    )

    const failure = await runOne(907, true)
    assert.equal(failure.polled.status, 'failed')
    assert.match(failure.polled.delta?.join('\n') ?? '', /dry-run 失败/)
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
    const workflow = interruptedWorkflow('o-r-903', 'https://github.com/o/r/issues/903', join(tempHome, 'worktree'))
    workflow.devTaskId = 'dev-before-restart'
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
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

test('/history queries an older round by project and issue while binding the round to that issue', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-history-round-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow('o-r-907', 'https://github.com/o/r/issues/907', join(tempHome, 'worktree'))
    const older = 'dev-1720000000000-older'
    const current = 'dev-1720000005000-current'
    workflow.devTaskId = current
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    await startTaskLog(workflow, 'dev', older)
    await appendTaskLog(workflow, 'dev', older, 1, 'older round')
    await startTaskLog(workflow, 'dev', current)
    await appendTaskLog(workflow, 'dev', current, 1, 'current round')

    const result = await get(createHandler(), `/clickvibe/api/history?owner=o&repo=r&issue=907&kind=dev&round=${older}`)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.lines, ['older round'])
    assert.equal(result.body.taskId, older)

    const wrongIssue = await get(
      createHandler(),
      `/clickvibe/api/history?owner=o&repo=r&issue=999&kind=dev&round=${older}`,
    )
    assert.equal(wrongIssue.status, 404)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/history restores structured agent records and keeps legacy lines compatible', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-history-events-'))
  process.env.HOME = tempHome
  try {
    const workflow = interruptedWorkflow('o-r-906', 'https://github.com/o/r/issues/906', join(tempHome, 'worktree'))
    workflow.devTaskId = 'dev-1720000000000-event'
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    await appendLog(
      workflow.key,
      'dev',
      encodeLiveLogEvent({
        source: 'agent',
        agent: 'codex',
        kind: 'command',
        text: '$ pnpm test',
      }),
    )
    await appendLog(workflow.key, 'dev', '[clickvibe] legacy system line')

    const result = await get(createHandler(), '/clickvibe/api/history?taskId=dev-1720000000000-event')
    assert.deepEqual(result.body.lines, ['$ pnpm test', '[clickvibe] legacy system line'])
    assert.deepEqual(result.body.events, [
      { source: 'agent', agent: 'codex', kind: 'command', text: '$ pnpm test' },
      { source: 'system', kind: 'system', text: '[clickvibe] legacy system line' },
    ])
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
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
    key,
    url,
    repoKey: 'o/r',
    worktree,
    branch: 'r-issue-17',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'old-dev',
    devSessionId: 'dead-session',
    devSessionAgent: 'codex',
    devInterrupted: true,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '29',
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    issueSnapshot: {
      url,
      title: 'persisted issue',
      body: contractBody('persisted'),
      state: 'OPEN',
      updatedAt: '2026-08-21T00:00:00Z',
      comments: [],
    },
    updatedAt: 1,
    events: [],
  }
}

async function waitForTask(listener: RequestListener, taskId: string): Promise<{ delta: string[] }> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const polled = await post(listener, '/clickvibe/api/develop/poll', { taskId, cursor: 0 })
    const body = polled.body as { ok: boolean; done?: boolean; delta?: string[] }
    if (body.done) {
      const task = liveTasks.get(taskId)
      assert.ok(task, `completed task ${taskId} disappeared before persistence quiesced`)
      await waitForTaskPersistence(task)
      return { delta: body.delta ?? [] }
    }
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
    workflow.events.push({
      kind: 'review',
      at: '2026-08-22T00:00:00Z',
      hash: 'old123',
      round: 1,
      agent: 'claude',
      verdict: { passed: false, issues: ['修复竞态', '补充失败测试'] },
      publication: {
        target: 'pr',
        status: 'posted',
        url: 'https://github.com/o/r/pull/29#issuecomment-99',
      },
    })
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    await appendLog(workflow.key, 'dev', 'prior run must be rotated')
    const starts: Array<{ command: string; workdir?: string; prompt: string }> = []
    const comments: Array<{ command: string; body: string }> = []
    const reviewUpdates: Array<{ command: string; body: string }> = []
    const currentIssue = {
      url: workflow.url,
      title: 'resume issue',
      body: contractBody('fallback'),
      state: 'OPEN',
      updatedAt: 'now',
      comments: [],
    }
    const reviewComments = [
      {
        author: { login: 'review-bot' },
        body: '== Review Meta ==\n- event: review\n- passed: false\n\n- 修复竞态\n- 补充失败测试',
      },
    ]
    const handler = createHandler(
      async (spec) => {
        if (spec.command.includes('/issues/comments/99') && spec.command.includes('PATCH')) {
          reviewUpdates.push({ command: spec.command, body: spec.stdin ?? '' })
          return { exitCode: 0, stdout: { text: '{}' }, stderr: { text: '' } }
        }
        const api = githubApi(spec.command, { item: currentIssue, prComments: reviewComments })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command.startsWith('git merge-base '))
          return { exitCode: 0, stdout: { text: 'base123\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git log '))
          return { exitCode: 0, stdout: { text: 'abc123\u001f修复 review 意见\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git diff --numstat '))
          return { exitCode: 0, stdout: { text: '12\t3\tsrc/fix.ts\n' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          comments.push({ command: spec.command, body })
          reviewComments.push({ author: { login: 'clickvibe' }, body })
          return {
            exitCode: 0,
            stdout: { text: 'HTTP/1.1 201\n\n{"id":1,"html_url":"https://github.com/o/r/pull/29#issuecomment-1"}' },
            stderr: { text: '' },
          }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        starts.push({ command: spec.command, workdir: spec.workdir, prompt: spec.stdin ?? '' })
        const fresh = starts.length === 2
        let read = false
        return {
          status: 'running',
          exitCode: fresh ? 0 : 1,
          done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return {
              delta: fresh ? '{"type":"thread.started","thread_id":"new-session"}\n' : 'no rollout found\n',
              lossy: false,
            }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'resume',
        url: workflow.url,
        agent: 'codex',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = (await post(
      handler,
      '/clickvibe/api/resume',
      {
        url: workflow.url,
        agent: 'codex',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    const completed = await waitForTask(handler, resumed.body.taskId)
    assert.equal(starts.length, 2)
    assert.match(starts[0].command, /danger-full-access resume 'dead-session'/)
    assert.equal(starts[1].command, `codex exec -c 'approval_policy="never"' -s danger-full-access --json -`)
    assert.deepEqual(
      starts.map((start) => start.workdir),
      [worktree, worktree],
    )
    for (const start of starts) {
      assert.match(start.prompt, /=== 需求快照 ===/)
      assert.match(start.prompt, /updatedAt: now/)
      assert.match(start.prompt, /## 验收标准\n- \[ \] fallback/)
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
    assert.equal(reviewUpdates.length, 1)
    assert.match(JSON.parse(reviewUpdates[0].body).body, /- \[已于第 2 轮修复\] 修复竞态/)
    assert.match(JSON.parse(reviewUpdates[0].body).body, /- \[已于第 2 轮修复\] 补充失败测试/)
    assert.match(comments[0].command, /repos\/o\/r\/issues\/29\/comments/)
    assert.match(comments[0].body, /^== Dev Meta ==\n- event: dev\n- commit: abc123\n- issue: #917\n- fixed: 2/m)
    assert.match(comments[0].body, /- round: 2\n- stats: commits=1 filesChanged=1 insertions=12 deletions=3/)
    assert.match(comments[0].body, /- \[已于第 2 轮修复\] 修复竞态\n- \[已于第 2 轮修复\] 补充失败测试/)
    const delivery = reloaded?.events.at(-1)
    assert.equal(delivery?.kind, 'resume')
    assert.equal(delivery?.round, 2)
    assert.equal(delivery?.agent, 'codex')
    assert.equal(delivery?.taskId, resumed.body.taskId)
    assert.equal(typeof delivery?.durationMs, 'number')
    assert.deepEqual(delivery?.stats, {
      commits: [{ hash: 'abc123', subject: '修复 review 意见' }],
      filesChanged: 1,
      insertions: 12,
      deletions: 3,
      diffstat: [{ path: 'src/fix.ts', insertions: 12, deletions: 3 }],
    })
    assert.equal(delivery?.publication?.status, 'posted')
    assert.equal(delivery?.publication?.target, 'pr')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('lossy agent output recovers the missing head from the host spill file into the panel and session id', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-spill-recovery-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-931', 'https://github.com/o/r/issues/931', worktree)
    workflow.devSessionId = null
    workflow.devSessionAgent = null
    await commitWorkflowFixture(workflow, null)
    const currentIssue = {
      url: workflow.url,
      title: 'recover issue',
      body: contractBody('recover'),
      state: 'OPEN',
      updatedAt: '2026-08-22T08:00:00Z',
      comments: [],
    }
    const spillFile = join(tempHome, 'agent-stdout.log')
    await writeFile(
      spillFile,
      [
        '{"type":"thread.started","thread_id":"recovered-session"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"lost in the host buffer"}}',
        '',
      ].join('\n'),
    )
    const starts: Array<{ command: string; prompt: string }> = []
    const comments: Array<{ command: string; body: string }> = []
    const issueComments: Array<{ author: { login: string }; body: string }> = []
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, { item: currentIssue, prComments: issueComments })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command.startsWith('git merge-base '))
          return { exitCode: 0, stdout: { text: 'base123\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git log '))
          return { exitCode: 0, stdout: { text: 'abc123\u001f完成实现\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git diff --numstat '))
          return { exitCode: 0, stdout: { text: '1\t1\tsrc/recovered.ts\n' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          comments.push({ command: spec.command, body })
          issueComments.push({ author: { login: 'clickvibe' }, body })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":1}' }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        starts.push({ command: spec.command, prompt: spec.stdin ?? '' })
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 30)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return {
              delta: '{"type":"item.completed","item":{"type":"agent_message","text":"visible tail"}}\n',
              lossy: true,
              stdoutSpillPath: spillFile,
            }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'resume',
        url: workflow.url,
        agent: 'codex',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = (await post(
      handler,
      '/clickvibe/api/resume',
      {
        url: workflow.url,
        agent: 'codex',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    const completed = await waitForTask(handler, resumed.body.taskId)

    assert.ok(
      completed.delta.some((line) => line.includes('visible tail')),
      'live tail rendered',
    )
    assert.ok(
      completed.delta.some((line) => line.includes('lost in the host buffer')),
      'recovered head rendered',
    )
    assert.ok(
      completed.delta.some((line) => line.includes('已从宿主 spill 文件恢复 2 行缺失的 Agent 输出')),
      'recovery notice rendered',
    )
    assert.ok(
      completed.delta.some((line) => line.includes('宿主流式缓冲已丢失部分 Agent 输出')),
      'lossy gap notice rendered',
    )
    assert.equal(starts.length, 1)
    assert.equal(comments.length, 1)
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.devSessionId, 'recovered-session')
    assert.equal(reloaded?.devSessionAgent, 'codex')
    const historyEvents = (await readLogHistory(workflow.key, 'dev')).map(decodeLiveLogLine)
    assert.ok(historyEvents.some((event) => event.text.includes('lost in the host buffer')))
    assert.ok(historyEvents.some((event) => event.text.includes('已从宿主 spill 文件恢复 2 行')))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('completed development without a PR uses the current contract and appends its Dev Meta comment', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-comment-fallback-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-920', 'https://github.com/o/r/issues/920', worktree)
    workflow.prNumber = null
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const comments: Array<{ command: string; body: string }> = []
    const issueComments: Array<{ author: { login: string }; body: string }> = []
    const prompts: string[] = []
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, {
          item: {
            url: workflow.url,
            number: 920,
            title: 'persisted issue',
            body: contractBody('persisted'),
            state: 'OPEN',
            updatedAt: '2026-09-03T00:00:00Z',
            comments: issueComments,
          },
        })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD') {
          return { exitCode: 0, stdout: { text: 'def4567' }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          comments.push({ command: spec.command, body })
          issueComments.push({ author: { login: 'clickvibe' }, body })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":3}' }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        prompts.push(spec.stdin ?? '')
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: '{"type":"thread.started","thread_id":"continued-session"}\n', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'resume',
        url: workflow.url,
        agent: 'codex',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = (await post(
      handler,
      '/clickvibe/api/resume',
      {
        url: workflow.url,
        agent: 'codex',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    await waitForTask(handler, resumed.body.taskId)

    assert.equal(prompts.length, 1)
    assert.doesNotMatch(prompts[0], /持久化回退/)
    assert.match(prompts[0], /updatedAt: 2026-09-03T00:00:00Z/)
    assert.match(prompts[0], /## 验收标准\n- \[ \] persisted/)
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /repos\/o\/r\/issues\/920\/comments/)
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    let issueReads = 0
    let starts = 0
    const currentIssue = {
      url: workflow.url,
      title: 'resume gate',
      body: contractBody('one task'),
      state: 'OPEN',
      updatedAt: '2026-08-22T07:00:00Z',
      comments: [],
    }
    const prComments: Array<{ author: { login: string }; body: string }> = []
    const handler = createHandler(
      async (spec) => {
        if (/gh api .*\/issues\/930'/.test(spec.command)) {
          issueReads += 1
          await new Promise((resolve) => setTimeout(resolve, 25))
          return githubApi(spec.command, { item: currentIssue })
        }
        const api = githubApi(spec.command, { item: currentIssue, prComments })
        if (api) return api
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          prComments.push({ author: { login: 'clickvibe' }, body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":1}' }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      () => {
        starts += 1
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 50)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: '{"type":"thread.started","thread_id":"resume-gate"}\n', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = () =>
      post(
        handler,
        '/clickvibe/api/authorize',
        {
          action: 'resume',
          url: workflow.url,
          agent: 'codex',
          context: '',
        },
        headers,
      ) as Promise<{ status: number; body: { authorizationId?: string; authorizationDigest?: string } }>
    const [firstAuth, secondAuth] = await Promise.all([authorize(), authorize()])
    const resume = (authorization: typeof firstAuth.body) =>
      post(
        handler,
        '/clickvibe/api/resume',
        {
          url: workflow.url,
          agent: 'codex',
          context: '',
          authorizationId: authorization.authorizationId,
          authorizationDigest: authorization.authorizationDigest,
        },
        headers,
      ) as Promise<{ status: number; body: { ok: boolean; taskId?: string } }>
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const handler = createHandler(
      async (spec) => {
        if (spec.command === 'git rev-parse --short HEAD') {
          return { exitCode: 0, stdout: { text: '987abcd' }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: `offline-${'x'.repeat(700)}` } }
        }
        if (spec.command.includes('/issues/29/comments') && !spec.command.includes('--method')) {
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n[]' }, stderr: { text: '' } }
        }
        const api = githubApi(spec.command, {
          item: {
            url: workflow.url,
            number: 921,
            title: 'publication failure',
            body: contractBody('publication failure'),
            state: 'OPEN',
            updatedAt: '2026-09-03T00:00:00Z',
            comments: [],
          },
        })
        if (api) return api
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      () => {
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: '{"type":"thread.started","thread_id":"failure-session"}\n', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'resume',
        url: workflow.url,
        agent: 'codex',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = (await post(
      handler,
      '/clickvibe/api/resume',
      {
        url: workflow.url,
        agent: 'codex',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.ok(resumed.body.taskId)
    await waitForTask(handler, resumed.body.taskId)

    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.stage, 'review-ready')
    assert.equal(reloaded?.events.length, 1)
    assert.equal(reloaded?.events[0].hash, '987abcd')
    assert.equal(reloaded?.events[0].fixed, 1)
    assert.equal(reloaded?.events[0].publication?.target, 'pr')
    // A lost transport response with an unproving readback is 'unknown' —
    // the comment may exist upstream; recovery settles it by readback (F4).
    assert.equal(reloaded?.events[0].publication?.status, 'unknown')
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const starts: Array<{ command: string; prompt: string }> = []
    const reviewedBody = contractBody('frozen review contract')
    const reviewedUpdatedAt = '2026-08-22T01:02:03Z'
    const issueSpill = join(tempHome, 'issue-contract.json')
    const currentIssue = {
      url: workflow.url,
      number: 918,
      title: 'review issue',
      body: reviewedBody,
      state: 'OPEN',
      updatedAt: reviewedUpdatedAt,
      comments: [{ author: { login: 'bot' }, body: 'related note' }],
    }
    await writeFile(issueSpill, included(restIssue(currentIssue)))
    let reviewFetches = 0
    const comments: Array<{ command: string; body: string }> = []
    const issueComments: Array<{ author: { login: string }; body: string }> = []
    const reviews: Array<{ state: string; body: string }> = []
    const approvals: Array<{ command: string; body: string }> = []
    const issueTimeouts: number[] = []
    const pr = {
      number: 29,
      state: 'open',
      html_url: 'https://github.com/o/r/pull/29',
      updated_at: reviewedUpdatedAt,
      base: { ref: 'main' },
      head: { ref: workflow.branch },
    }
    const handler = createHandler(
      async (spec) => {
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
        const api = githubApi(spec.command, { item: currentIssue, pr, prComments: issueComments, reviews })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command.startsWith('git merge-base '))
          return { exitCode: 0, stdout: { text: 'base123\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git log '))
          return { exitCode: 0, stdout: { text: 'abc123\u001f完成实现\n' }, stderr: { text: '' } }
        if (spec.command.startsWith('git diff --numstat '))
          return { exitCode: 0, stdout: { text: '8\t1\tsrc/reviewed.ts\n' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          comments.push({ command: spec.command, body })
          issueComments.push({ author: { login: 'clickvibe' }, body })
          return {
            exitCode: 0,
            stdout: { text: 'HTTP/1.1 201\n\n{"id":2,"html_url":"https://github.com/o/r/pull/29#issuecomment-2"}' },
            stderr: { text: '' },
          }
        }
        if (spec.command.includes('--method POST') && spec.command.includes('/reviews')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          approvals.push({ command: spec.command, body })
          reviews.push({ state: 'APPROVED', body, commit_id: 'abc123', user: { login: 'clickvibe' } })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":9}' }, stderr: { text: '' } }
        }
        if (spec.command.includes("'user'")) {
          return { exitCode: 0, stdout: { text: included({ login: 'clickvibe' }) }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        starts.push({ command: spec.command, prompt: spec.stdin ?? '' })
        const fresh = starts.length === 2
        let read = false
        return {
          status: 'running',
          exitCode: fresh ? 0 : 1,
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
            return {
              delta: fresh ? '{"type":"thread.started","thread_id":"new-review"}\n' : 'no rollout found\n',
              lossy: false,
            }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'review',
        url: workflow.url,
        agent: 'codex',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const reviewed = (await post(
      handler,
      '/clickvibe/api/review',
      {
        url: workflow.url,
        agent: 'codex',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
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
      assert.match(
        start.prompt,
        new RegExp(`canonical contract fingerprint: ${contractRef(workflow.url, reviewedBody, '').fingerprint}`),
      )
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
    assert.equal(
      reloaded?.events.at(-1)?.issueContract && 'fingerprint' in reloaded.events.at(-1)!.issueContract!,
      true,
    )
    assert.equal(reloaded?.events.at(-1)?.round, 1)
    assert.equal(reloaded?.events.at(-1)?.agent, 'codex')
    assert.equal(reloaded?.events.at(-1)?.taskId, reviewed.body.taskId)
    assert.equal(reloaded?.events.at(-1)?.stats?.filesChanged, 1)
    assert.ok(completed.delta.some((line) => line.includes('review 结束,退出码 0')))
    assert.ok(completed.delta.some((line) => line.includes('review 结论来源')))
    assert.equal(reloaded?.reviewResult?.commentUrl, 'https://github.com/o/r/pull/29#issuecomment-2')
    assert.equal(comments.length, 1)
    assert.match(comments[0].command, /repos\/o\/r\/issues\/29\/comments/)
    assert.match(
      comments[0].body,
      /^== Review Meta ==\n- event: review\n- commit: abc123\n- issue: #918\n- passed: true\n- next: merge/m,
    )
    assert.match(comments[0].body, /下一步:可合并当前提交。/)
    assert.equal(approvals.length, 1)
    assert.match(approvals[0].command, /repos\/o\/r\/pulls\/29\/reviews/)
    assert.equal(approvals[0].body, '**身份：Review Agent**\n\nLGTM')
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)

    let issueCalls = 0
    let notifyIssueEntered!: () => void
    let releaseIssue!: () => void
    const issueEntered = new Promise<void>((resolve) => {
      notifyIssueEntered = resolve
    })
    const issueBlocked = new Promise<void>((resolve) => {
      releaseIssue = resolve
    })
    let finishProcess!: () => void
    const processDone = new Promise<void>((resolve) => {
      finishProcess = resolve
    })
    const currentIssue = {
      url: workflow.url,
      number: 920,
      title: 'review issue',
      body: contractBody('gate'),
      state: 'OPEN',
      updatedAt: '2026-08-22T03:04:05Z',
      comments: [],
    }
    const handler = createHandler(
      async (spec) => {
        if (/gh api .*\/issues\/920'/.test(spec.command)) {
          issueCalls += 1
          notifyIssueEntered()
          await issueBlocked
          return githubApi(spec.command, { item: currentIssue })
        }
        const api = githubApi(spec.command, {
          item: currentIssue,
          pr: {
            number: 29,
            state: 'open',
            html_url: 'https://github.com/o/r/pull/29',
            base: { ref: 'main' },
            head: { ref: workflow.branch },
          },
        })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'gate123' }, stderr: { text: '' } }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      () => ({
        status: 'running',
        exitCode: 0,
        done: processDone,
        readOutput() {
          return { delta: '', lossy: false }
        },
        kill() {
          return true
        },
      }),
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorize = async () =>
      post(
        handler,
        '/clickvibe/api/authorize',
        {
          action: 'review',
          url: workflow.url,
          agent: 'codex',
          context: '',
        },
        headers,
      ) as Promise<{ status: number; body: { authorizationId?: string; authorizationDigest?: string } }>
    const [auth1, auth2] = await Promise.all([authorize(), authorize()])
    const reviewPayload = (auth: typeof auth1) => ({
      url: workflow.url,
      agent: 'codex',
      context: '',
      authorizationId: auth.body.authorizationId,
      authorizationDigest: auth.body.authorizationDigest,
    })

    const firstPromise = post(handler, '/clickvibe/api/review', reviewPayload(auth1), headers)
    await issueEntered
    const second = (await Promise.race([
      post(handler, '/clickvibe/api/review', reviewPayload(auth2), headers),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('duplicate review waited for contract fetch')), 200),
      ),
    ])) as { status: number; body: { taskId?: string } }
    assert.equal(second.status, 200)
    assert.equal(issueCalls, 1)

    releaseIssue()
    const first = (await firstPromise) as { status: number; body: { taskId?: string } }
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
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const starts: string[] = []
    const reviewedBody = contractBody('current contract')
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, {
          item: {
            url: workflow.url,
            number: 919,
            title: 'review issue',
            body: reviewedBody,
            state: 'OPEN',
            updatedAt: '2026-08-22T02:03:04Z',
          },
          pr: { number: 29, base: { ref: 'main' }, head: { ref: workflow.branch } },
        })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'def456' }, stderr: { text: '' } }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        starts.push(spec.command)
        let read = false
        return {
          status: 'running',
          exitCode: 0,
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
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'review',
        url: workflow.url,
        agent: 'claude',
        context: '',
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const reviewed = (await post(
      handler,
      '/clickvibe/api/review',
      {
        url: workflow.url,
        agent: 'claude',
        context: '',
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
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
    number: 7,
    title: 'issue 7',
    state: 'OPEN',
    body: contractBody('做 X').replace('## 依赖\n无', '## 依赖\nBlocked by #5'),
    updatedAt: '2026-09-03T00:00:00Z',
    comments: [],
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
  const deps = (
    result.body as {
      ok: true
      data: {
        dependencies?: { blockedBy: { number: number }[]; blocking: { number: number }[] }
        contractObservation?: {
          state: 'known'
          snapshot: { fingerprint: string; dependencies: { state: string } }
        }
      }
    }
  ).data.dependencies
  assert.ok(deps)
  assert.deepEqual(
    deps.blockedBy.map((d) => d.number),
    [5],
  )
  assert.deepEqual(
    deps.blocking.map((d) => d.number),
    [8],
  )
  const contract = (
    result.body as {
      ok: true
      data: {
        contractObservation?: {
          state: 'known'
          snapshot: { fingerprint: string; dependencies: { state: string } }
        }
      }
    }
  ).data.contractObservation
  assert.equal(contract?.state, 'known')
  assert.match(contract?.snapshot.fingerprint ?? '', /^wic1_[A-Za-z0-9_-]{43}$/)
  assert.equal(contract?.snapshot.dependencies.state, 'known')
})

test('/fetch on an issue without a 依赖 section yields no blockedBy (and no blocking)', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/5',
    number: 5,
    title: 'issue 5',
    state: 'OPEN',
    body: '## 目标\n做 Y',
    comments: [],
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
  const deps = (result.body as { ok: true; data: { dependencies?: { blockedBy: unknown[]; blocking: unknown[] } } })
    .data.dependencies
  assert.ok(deps)
  assert.deepEqual(deps.blockedBy, [])
  assert.deepEqual(
    deps.blocking.map((d) => (d as { number: number }).number),
    [7],
  )
})

test('/develop automatic mode fails closed before worktree creation for invalid or blocked issues', async () => {
  const url = 'https://github.com/o/r/issues/77'
  const invalid = {
    url,
    number: 77,
    title: 'invalid',
    state: 'OPEN',
    updatedAt: '2026-08-22T00:00:00Z',
    body: '## 目标\n做事\n\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
    comments: [],
  }
  const invalidHandler = createHandler(async (spec) => {
    const api = githubApi(spec.command, { item: invalid, issues: [invalid] })
    if (api) return api
    throw new Error(`worktree command must not run: ${spec.command}`)
  })
  const invalidResult = await post(invalidHandler, '/clickvibe/api/develop', {
    url,
    agent: 'dryrun',
    automatic: true,
  })
  assert.equal(invalidResult.status, 400)
  assert.match(invalidResult.body.error ?? '', /unknown 字段/)

  // The two phases simulate DIFFERENT GitHub states in one process; the
  // process-level Gateway owner would otherwise serve phase 1's aggregate.
  resetGithubGatewayOwnerForTests()
  const blocked = {
    ...invalid,
    title: 'blocked',
    updatedAt: '2026-08-22T00:01:00Z',
    body: '## 目标\n做事\n\n## 验收标准\n- [ ] 完成\n\n## 依赖\nBlocked by #8\n## 非目标\n无\n## 约束\n无',
  }
  const dependency = { number: 8, title: 'dependency', state: 'OPEN', body: '' }
  const blockedHandler = createHandler(async (spec) => {
    const api = githubApi(spec.command, { item: blocked, issues: [blocked, dependency] })
    if (api) return api
    throw new Error(`worktree command must not run: ${spec.command}`)
  })
  const blockedResult = await post(blockedHandler, '/clickvibe/api/develop', {
    url,
    agent: 'dryrun',
    automatic: true,
  })
  assert.equal(blockedResult.status, 400)
  assert.match(blockedResult.body.error ?? '', /存在未完成的直接依赖/)
})

test('/develop automatic mode rejects a branch with commits when workflow history is missing', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-auto-history-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      `repos:\n  history/repo: ${repo}\nworktreeRoot: ${worktreeRoot}\n`,
    )
    const url = 'https://github.com/history/repo/issues/910'
    const issue = {
      url,
      number: 910,
      title: 'lost workflow',
      state: 'OPEN',
      updatedAt: '2026-08-22T00:00:00Z',
      body: contractBody('自动开发', '完成'),
      comments: [],
    }
    const commands: string[] = []
    const handler = createHandler(async (spec) => {
      commands.push(spec.command)
      const api = githubApi(spec.command, { item: issue, issues: [issue], pulls: [] })
      if (api) return api
      if (spec.command.startsWith('if git show-ref --verify --quiet')) {
        return { exitCode: 0, stdout: { text: 'repo-issue-910' }, stderr: { text: '' } }
      }
      if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
        return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
      }
      if (spec.command.startsWith('git rev-list --count')) {
        return { exitCode: 0, stdout: { text: '1' }, stderr: { text: '' } }
      }
      throw new Error(`unexpected command: ${spec.command}`)
    })

    const result = await post(handler, '/clickvibe/api/develop', { url, agent: 'dryrun', automatic: true })
    assert.equal(result.status, 400)
    assert.match(result.body.error ?? '', /当前阶段不是首次开发/)
    assert.ok(commands.some((command) => command.startsWith('git rev-list --count')))
    assert.ok(commands.every((command) => !command.startsWith('git worktree add')))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('/fetch keeps issue data but reports dependency refresh failure without inventing an empty graph', async () => {
  const item = {
    url: 'https://github.com/ai-daming/clickvibe/issues/938',
    number: 938,
    title: 'dependency refresh failure',
    state: 'OPEN',
    body: '## 依赖\n\nBlocked by #4',
    comments: [],
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
    number: 41,
    title: 'REST PR',
    state: 'open',
    body: 'body',
    html_url: url,
    user: { login: 'author' },
    created_at: '2026-08-22T01:00:00Z',
    updated_at: '2026-08-22T02:00:00Z',
    additions: 12,
    deletions: 3,
    changed_files: 2,
    commits: 4,
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    base: { ref: 'main' },
    head: { ref: 'feature', sha: 'abc123' },
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

  const first = (await post(handler, '/clickvibe/api/fetch', { url })) as {
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
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-rate-limit-circuit-'))
  process.env.HOME = tempHome
  try {
    const reset = Math.floor((Date.now() + 10 * 60_000) / 1000)
    let githubRequests = 0
    const handler = createHandler(async (spec) => {
      assert.match(spec.command, /^gh api /, `unexpected non-GitHub shell command: ${spec.command}`)
      githubRequests++
      return {
        exitCode: 1,
        stdout: {
          text: [
            'HTTP/2.0 403 Forbidden',
            'x-ratelimit-remaining: 0',
            `x-ratelimit-reset: ${reset}`,
            '',
            JSON.stringify({ message: 'API rate limit exceeded' }),
          ].join('\n'),
        },
        stderr: { text: '' },
      }
    })

    const first = await post(handler, '/clickvibe/api/fetch', { url: 'https://github.com/o/r/issues/41' })
    // r3 declared behavior change: the pre-probe bypass is gone, so a route
    // with ZERO GitHub operations (empty-repo /state) no longer 429s by
    // side effect. The circuit protection is asserted on a route that
    // actually submits operations — its admission must reject pre-dispatch.
    const second = await post(handler, '/clickvibe/api/fetch', { url: 'https://github.com/o/r/issues/41' })
    assert.equal(first.status, 429)
    assert.equal(second.status, 429)
    assert.match(first.body.error ?? '', /^GitHub 额度已用完,约 \d{2}:\d{2} 恢复$/)
    assert.equal(second.body.error, first.body.error)
    assert.equal(githubRequests, 1, 'open circuit must reject without another GitHub request')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('repository GitHub aggregation uses its short TTL cache and force refresh bypasses it', async () => {
  const issue = { number: 1, title: 'cached', state: 'open', body: '', html_url: 'https://github.com/o/r/issues/1' }
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
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
    {
      number: 5,
      title: 'dependency',
      state: 'closed',
      body: '',
      html_url: 'https://github.com/o/r/issues/5',
      milestone: null,
    },
    {
      number: 7,
      title: 'delivered but still open',
      state: 'open',
      body: '## 依赖\nBlocked by #5',
      html_url: 'https://github.com/o/r/issues/7',
      milestone: { title: 'M1' },
    },
    {
      number: 8,
      title: 'never developed',
      state: 'open',
      body: contractBody('自动开发', '完成'),
      html_url: 'https://github.com/o/r/issues/8',
      milestone: null,
    },
  ]
  const prs = [
    {
      number: 19,
      state: 'closed',
      merged_at: '2026-08-22T00:00:00Z',
      head: { ref: 'r-issue-7' },
      html_url: 'https://github.com/o/r/pull/19',
    },
  ]
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included(allIssues) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included(prs) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const issues = result.issues as Array<{
    number: number
    milestone: { title: string } | null
    blockedBy: { number: number; state: string }[]
    workflow: { prNumber: string | null; derived: { status: string; nextAction: { kind: string; label: string } } }
    autoDevelopment: { ready: boolean; status: string }
  }>
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [7, 8],
  )
  assert.deepEqual(issues[0].blockedBy, [{ number: 5, title: 'dependency', state: 'CLOSED' }])
  assert.equal(issues[0].milestone?.title, 'M1')
  assert.equal(issues[0].workflow.prNumber, '19')
  assert.equal(issues[0].workflow.derived.status, 'passed')
  assert.equal(issues[0].workflow.derived.nextAction.kind, 'none')
  assert.equal(issues[0].autoDevelopment.ready, false)
  assert.equal(issues[1].workflow.derived.status, 'idle')
  assert.equal(issues[1].workflow.derived.nextAction.label, '开始开发')
  assert.deepEqual(issues[1].autoDevelopment, {
    status: 'ready',
    ready: true,
    reason: '契约完整且直接依赖均已完成',
  })
})

test('repo ready excludes recovery even when the generic next action is develop', async () => {
  const issue = {
    number: 81,
    title: 'resume existing development',
    state: 'open',
    body: contractBody('继续开发', '完成'),
    html_url: 'https://github.com/recovery/case/issues/81',
    milestone: null,
  }
  const workflow = interruptedWorkflow('recovery-case-81', issue.html_url, '/missing/worktree/case-issue-81')
  workflow.repoKey = 'recovery/case'
  workflow.branch = 'case-issue-81'
  workflow.stage = 'idle'
  workflow.baseRef = 'origin/main @ abc123'
  workflow.prNumber = null
  workflow.devInterrupted = false
  workflow.events = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }

  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'recovery/case' },
    {
      config: { repos: { 'recovery/case': '/remote/case' }, worktreeRoot: '/remote/worktrees' },
      workflows: [workflow],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as {
    workflow: { derived: { nextAction: { kind: string } } }
    autoDevelopment: { ready: boolean; status: string }
  }
  assert.equal(item.workflow.derived.nextAction.kind, 'develop')
  assert.deepEqual(item.autoDevelopment, {
    status: 'not-startable',
    ready: false,
    reason: '当前阶段不是首次开发',
  })
})

test('repo aggregation unlocks closed dependencies with an idempotent comment before rewriting the ledger', async () => {
  const body = '## 目标\n自动开发\n\n## 验收标准\n- [ ] 可启动\n\n## 依赖\nBlocked by #8\n## 非目标\n无\n## 约束\n无'
  const issue = {
    number: 9,
    title: 'ready after dependency',
    state: 'open',
    body,
    html_url: 'https://github.com/o/r/issues/9',
    milestone: null,
  }
  const dependency = {
    number: 8,
    title: 'done',
    state: 'closed',
    body: '',
    html_url: 'https://github.com/o/r/issues/8',
    milestone: null,
  }
  const writes: Array<{ command: string; stdin?: string }> = []
  const postedComments: Array<{ body: string }> = []
  let issueBody = issue.body
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; stdin?: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue, dependency]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        // The unlock comment write transaction scans comments before posting
        // and reads them back afterwards — serve the posted bodies.
        if (spec.command.includes('/issues/9/comments') && !spec.command.includes('--method')) {
          return { exitCode: 0, stdout: { text: included(postedComments) }, stderr: { text: '' } }
        }
        // The issue body PATCH transaction reads the issue back for its
        // predicate — serve the rewritten body.
        if (spec.command.includes('/issues/9') && !spec.command.includes('--method')) {
          return { exitCode: 0, stdout: { text: included({ ...issue, body: issueBody }) }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method POST')) {
          writes.push(spec)
          postedComments.push({ body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
          return { exitCode: 0, stdout: { text: included({ id: 1 }) }, stderr: { text: '' } }
        }
        if (spec.command.includes('--method PATCH')) {
          writes.push(spec)
          issueBody = JSON.parse(spec.stdin ?? '{}').body ?? issueBody
          return {
            exitCode: 0,
            stdout: { text: included({ updated_at: '2026-08-22T08:00:00Z' }) },
            stderr: { text: '' },
          }
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [],
    },
  )
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

test('repo aggregation cools down failed dependency-ledger writes across forced refreshes', async () => {
  const body = '## 目标\n自动开发\n\n## 验收标准\n- [ ] 可启动\n\n## 依赖\nBlocked by #908\n## 非目标\n无\n## 约束\n无'
  const issue = {
    number: 909,
    title: 'retry later',
    state: 'open',
    body,
    html_url: 'https://github.com/cooldown/r/issues/909',
    milestone: null,
  }
  const dependency = {
    number: 908,
    title: 'done',
    state: 'closed',
    body: '',
    html_url: 'https://github.com/cooldown/r/issues/908',
    milestone: null,
  }
  let commentReads = 0
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue, dependency]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/issues/909/comments')) {
          commentReads += 1
          return { exitCode: 1, stdout: { text: included({ message: 'offline' }, 500) }, stderr: { text: 'offline' } }
        }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const overrides = {
    config: { repos: { 'cooldown/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
    workflows: [],
  }

  const first = await fetchRepositoryIssues(ctx as never, { repoKey: 'cooldown/r', forceRefresh: true }, overrides)
  const second = await fetchRepositoryIssues(ctx as never, { repoKey: 'cooldown/r', forceRefresh: true }, overrides)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  const firstLedger = first.issues.find((candidate) => (candidate as { number: number }).number === 909) as {
    dependencyLedger: { error?: string }
  }
  const secondLedger = second.issues.find((candidate) => (candidate as { number: number }).number === 909) as {
    dependencyLedger: { error?: string }
  }
  assert.match(firstLedger.dependencyLedger.error ?? '', /更新失败;冷却至/)
  assert.match(secondLedger.dependencyLedger.error ?? '', /更新冷却至/)
  // Slice B: one failed transaction reads comments twice — the marker scan
  // and the mandatory authoritative readback — then the cooldown gate keeps
  // the second forced refresh entirely offline.
  assert.equal(commentReads, 2, 'refreshes inside the cooldown must not retry GitHub writes')
})

test('repo aggregation keeps a closed issue visible while merged cleanup is pending', async () => {
  const issue = {
    number: 23,
    title: 'cleanup pending',
    state: 'closed',
    body: '',
    html_url: 'https://github.com/o/r/issues/23',
    milestone: null,
  }
  const workflow = interruptedWorkflow('o-r-23', issue.html_url, '/remote/worktrees/r-issue-23')
  workflow.branch = 'r-issue-23'
  workflow.stage = 'passed'
  workflow.delivery = {
    status: 'cleanup-pending',
    mergedAt: '2026-08-22T00:00:00Z',
    prHead: 'abcdef1',
    mergeStrategy: 'merge',
    cleanup: { worktree: false, localBranch: false, remoteBranch: false, issue: false },
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return {
            exitCode: 0,
            stdout: {
              text: included([
                {
                  number: 29,
                  state: 'closed',
                  merged_at: '2026-08-22T00:00:00Z',
                  head: { ref: workflow.branch },
                  html_url: 'https://github.com/o/r/pull/29',
                },
              ]),
            },
            stderr: { text: '' },
          }
        if (spec.command.includes('/pulls/29/reviews'))
          return {
            exitCode: 0,
            stdout: {
              text: included([
                { id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T00:00:00Z' },
              ]),
            },
            stderr: { text: '' },
          }
        if (spec.command.includes('/pulls/29'))
          return {
            exitCode: 0,
            stdout: {
              text: included({
                number: 29,
                state: 'closed',
                merged_at: '2026-08-22T00:00:00Z',
                head: { ref: workflow.branch, sha: 'abcdef1' },
                base: { ref: 'main' },
                html_url: 'https://github.com/o/r/pull/29',
              }),
            },
            stderr: { text: '' },
          }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [workflow],
    },
  )
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
    number: 7,
    title: 'issue 7',
    state: 'open',
    body: '',
    html_url: 'https://github.com/o/r/issues/7',
    milestone: null,
  }
  const workflow = {
    key: 'o-r-7',
    url: issue.html_url,
    repoKey: 'o/r',
    worktree: '/remote/worktrees/r/r-issue-7',
    branch: 'r-issue-7',
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
    reviewResult: null,
    prNumber: 29,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return {
            exitCode: 0,
            stdout: {
              text: included([
                {
                  number: 29,
                  state: 'closed',
                  merged_at: '2026-08-22T00:00:00Z',
                  head: { ref: 'r-issue-7' },
                  html_url: 'https://github.com/o/r/pull/29',
                },
              ]),
            },
            stderr: { text: '' },
          }
        throw new Error('snapshot fast path must not run: ' + spec.command)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [workflow as never],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as {
    workflow: { prNumber: string; derived: { status: string; nextAction: { kind: string } } }
  }
  assert.equal(item.workflow.prNumber, '29')
  assert.equal(item.workflow.derived.status, 'passed')
  assert.equal(item.workflow.derived.nextAction.kind, 'none')
  assert.equal(
    commands.filter((command) => command.startsWith('gh api ')).length,
    2,
    'only the issues+pulls snapshot, no per-PR detail',
  )
  // #8:列表项携带契约合规字段;空正文 = 缺 目标/验收标准/依赖(选前校验标记,不硬选)
  const contractItem = result.issues[0] as unknown as { contract: { ok: boolean; missing: string[] } }
  assert.equal(contractItem.contract.ok, false)
  assert.deepEqual(contractItem.contract.missing, ['目标', '验收标准', '依赖'])
})
test('repo issue aggregation fails closed when a stored PR cannot be refreshed by number', async () => {
  const issue = {
    number: 7,
    title: 'issue 7',
    state: 'open',
    body: '',
    html_url: 'https://github.com/o/r/issues/7',
    milestone: null,
  }
  const workflow = {
    key: 'o-r-7',
    url: issue.html_url,
    repoKey: 'o/r',
    worktree: '/remote/worktrees/r/r-issue-7',
    branch: 'renamed-branch',
    stage: 'passed',
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
    prNumber: 99,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/99'))
          return { exitCode: 1, stdout: { text: included({ message: 'offline' }, 500) }, stderr: { text: 'offline' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [workflow as never],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as {
    workflow: { prNumber: string; derived: { nextAction: { kind: string; label: string } } }
  }
  assert.equal(item.workflow.prNumber, '99')
  assert.deepEqual(item.workflow.derived.nextAction, {
    kind: 'none',
    label: '刷新 PR 状态',
    hint: 'GitHub PR 实时状态查询失败,为避免误合并已暂停动作',
  })
})

test('repo issue aggregation refreshes stored PR by number when its head no longer matches', async () => {
  const issue = {
    number: 7,
    title: 'issue 7',
    state: 'open',
    body: '',
    html_url: 'https://github.com/o/r/issues/7',
    milestone: null,
  }
  const workflow = {
    key: 'o-r-7',
    url: issue.html_url,
    repoKey: 'o/r',
    worktree: '/remote/worktrees/r/r-issue-7',
    branch: 'old-branch-name',
    stage: 'passed',
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
    prNumber: 99,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command.includes('/issues?'))
          return { exitCode: 0, stdout: { text: included([issue]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (spec.command.includes('/pulls/99/reviews'))
          return {
            exitCode: 0,
            stdout: {
              text: included([
                { id: 1, user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-22T01:00:00Z' },
              ]),
            },
            stderr: { text: '' },
          }
        if (spec.command.includes('/pulls/99'))
          return {
            exitCode: 0,
            stdout: {
              text: included({
                number: 99,
                state: 'closed',
                merged_at: '2026-08-22T00:00:00Z',
                head: { ref: 'new-branch-name' },
                html_url: 'https://github.com/o/r/pull/99',
              }),
            },
            stderr: { text: '' },
          }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [workflow as never],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const item = result.issues[0] as {
    workflow: { prNumber: string; derived: { status: string; nextAction: { kind: string } } }
  }
  assert.equal(item.workflow.prNumber, '99')
  assert.equal(item.workflow.derived.status, 'passed')
  assert.equal(item.workflow.derived.nextAction.kind, 'none')
})

test('repo issue aggregation uses unbounded pagination and keeps issues beyond 1000', async () => {
  const allIssues = Array.from({ length: 1001 }, (_, index) => ({
    number: index + 1,
    title: `issue ${index + 1}`,
    state: 'open',
    body: '',
    html_url: `https://github.com/o/r/issues/${index + 1}`,
    milestone: null,
  }))
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('/issues?')) {
          const page = Number(spec.command.match(/[?&]page=(\d+)/)?.[1] ?? 1)
          return {
            exitCode: 0,
            stdout: { text: included(allIssues.slice((page - 1) * 100, page * 100)) },
            stderr: { text: '' },
          }
        }
        if (spec.command.includes('/pulls?'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        throw new Error(`unexpected command: ${spec.command}`)
      },
    },
  }
  const result = await fetchRepositoryIssues(
    ctx as never,
    { repoKey: 'o/r' },
    {
      config: { repos: { 'o/r': '/remote/r' }, worktreeRoot: '/remote/worktrees' },
      workflows: [],
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.issues.length, 1001)
  assert.equal(commands.filter((command) => command.startsWith('gh api ')).length, 12)
})

test('develop with user context stays a first development and records the note in the timeline', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-develop-context-'))
  process.env.HOME = tempHome
  try {
    const repo = join(tempHome, 'repo')
    const worktreeRoot = join(tempHome, 'worktrees')
    await mkdir(repo, { recursive: true })
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(
      join(tempHome, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${worktreeRoot}`, ''].join('\n'),
    )
    const url = 'https://github.com/o/r/issues/54'
    const item = {
      url,
      title: 'context issue',
      body: contractBody('context'),
      state: 'OPEN',
      updatedAt: '2026-08-22T00:00:00Z',
      comments: [],
    }
    const expectedSnapshot = {
      url: item.url,
      title: item.title,
      body: item.body,
      state: item.state,
      updatedAt: item.updatedAt,
      comments: [],
    }
    const prompts: string[] = []
    const comments: Array<{ command: string; body: string }> = []
    const publishedComments: Array<{ author: { login: string }; body: string }> = []
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, { item })
        if (api) return api
        // 评论回读单独应答,不改写 item:后续 authorize 的 expectedSnapshot
        // 对比要求 issue 快照保持 comments 原样。
        if (spec.command.includes('/issues/54/comments') && !spec.command.includes('--method')) {
          return {
            exitCode: 0,
            stdout: { text: included([...item.comments, ...publishedComments].map(restComment)) },
            stderr: { text: '' },
          }
        }
        if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD')
          return { exitCode: 0, stdout: { text: 'origin/main' }, stderr: { text: '' } }
        if (spec.command === "git show-ref --verify --quiet 'refs/remotes/origin/main'; echo $?")
          return { exitCode: 0, stdout: { text: '0' }, stderr: { text: '' } }
        if (spec.command === "git rev-parse --short 'origin/main'")
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'f00d123' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          comments.push({ command: spec.command, body })
          publishedComments.push({ author: { login: 'clickvibe' }, body })
          return {
            exitCode: 0,
            stdout: { text: 'HTTP/1.1 201\n\n{"id":9,"html_url":"https://github.com/o/r/issues/54#issuecomment-9"}' },
            stderr: { text: '' },
          }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        prompts.push(spec.stdin ?? '')
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: `{"type":"thread.started","thread_id":"dev-session-${prompts.length}"}\n`, lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }

    // 首次开工:附加说明非空也必须是「开发」,不得沿用 context!==''→rework 的判定。
    const firstContext = '优先补齐边界测试,注意向后兼容'
    const firstAuthorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'develop',
        url,
        agent: 'codex',
        context: firstContext,
        expectedSnapshot,
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const first = (await post(
      handler,
      '/clickvibe/api/develop',
      {
        url,
        agent: 'codex',
        context: firstContext,
        authorizationId: firstAuthorized.body.authorizationId,
        authorizationDigest: firstAuthorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(first.status, 200, JSON.stringify(first.body))
    await waitForTask(handler, first.body.taskId ?? '')

    assert.match(prompts[0], /请执行 ClickVibe 开发阶段。/)
    assert.doesNotMatch(prompts[0], /返工阶段/)
    assert.match(prompts[0], /附加上下文:\n优先补齐边界测试,注意向后兼容/)
    let reloaded = await loadWorkflow('o-r-54')
    assert.equal(reloaded?.events.at(-1)?.kind, 'dev')
    assert.equal(reloaded?.events.at(-1)?.userContext, firstContext)
    assert.equal(typeof reloaded?.events.at(-1)?.durationMs, 'number')
    assert.ok((reloaded?.events.at(-1)?.durationMs ?? -1) >= 0)
    // 附加说明只进本地时间线,不进 GitHub 评论。
    assert.equal(comments[0].body.includes(firstContext), false)

    // 非首次 develop 带附加说明:保留既有「升级为返工」语义。
    const secondContext = '第二轮:按新约束调整实现'
    const secondAuthorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'develop',
        url,
        agent: 'codex',
        context: secondContext,
        expectedSnapshot,
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const second = (await post(
      handler,
      '/clickvibe/api/develop',
      {
        url,
        agent: 'codex',
        context: secondContext,
        authorizationId: secondAuthorized.body.authorizationId,
        authorizationDigest: secondAuthorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(second.status, 200, JSON.stringify(second.body))
    await waitForTask(handler, second.body.taskId ?? '')

    assert.match(prompts[1], /请执行 ClickVibe 按 Review 意见返工阶段。/)
    assert.match(prompts[1], /附加上下文:\n第二轮:按新约束调整实现/)
    reloaded = await loadWorkflow('o-r-54')
    assert.equal(reloaded?.events.at(-1)?.kind, 'rework')
    assert.equal(reloaded?.events.at(-1)?.userContext, secondContext)
    assert.equal(typeof reloaded?.events.at(-1)?.durationMs, 'number')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('resume (rework) carries the user context next to the review feedback and audits it locally', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-resume-context-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-921', 'https://github.com/o/r/issues/921', worktree)
    workflow.reviewResult = { passed: false, issues: ['修复竞态', '补充失败测试'] }
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const prompts: string[] = []
    const currentIssue = {
      url: workflow.url,
      title: 'resume issue',
      body: contractBody('context'),
      state: 'OPEN',
      updatedAt: 'now',
      comments: [],
    }
    const prComments: Array<{ author: { login: string }; body: string }> = []
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, { item: currentIssue, prComments })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          prComments.push({ author: { login: 'clickvibe' }, body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
          return {
            exitCode: 0,
            stdout: { text: 'HTTP/1.1 201\n\n{"id":4,"html_url":"https://github.com/o/r/pull/29#issuecomment-4"}' },
            stderr: { text: '' },
          }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        prompts.push(spec.stdin ?? '')
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: new Promise<void>((resolve) => setTimeout(resolve, 5)),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: '{"type":"thread.started","thread_id":"resumed-session"}\n', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const userContext = '重点先修竞态,再补并发测试'
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'resume',
        url: workflow.url,
        agent: 'codex',
        context: userContext,
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const resumed = (await post(
      handler,
      '/clickvibe/api/resume',
      {
        url: workflow.url,
        agent: 'codex',
        context: userContext,
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    await waitForTask(handler, resumed.body.taskId ?? '')

    // 服务端既有 review 意见注入与用户附加说明同时出现在 prompt。
    assert.match(prompts[0], /请执行 ClickVibe 按 Review 意见返工阶段。/)
    assert.match(prompts[0], /修复竞态/)
    assert.match(prompts[0], /重点先修竞态,再补并发测试/)
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.events.at(-1)?.kind, 'resume')
    assert.equal(reloaded?.events.at(-1)?.userContext, userContext)
    assert.equal(typeof reloaded?.events.at(-1)?.durationMs, 'number')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('review with user context appends it to the prompt and audits it in the review event', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-context-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = interruptedWorkflow('o-r-922', 'https://github.com/o/r/issues/922', worktree)
    workflow.stage = 'review-ready'
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    const starts: Array<{ command: string; prompt: string }> = []
    const reviewedBody = contractBody('review context')
    const currentIssue = {
      url: workflow.url,
      number: 922,
      title: 'review issue',
      body: reviewedBody,
      state: 'OPEN',
      updatedAt: '2026-08-22T02:00:00Z',
      comments: [],
    }
    const pr = {
      number: 29,
      state: 'open',
      html_url: 'https://github.com/o/r/pull/29',
      updated_at: '2026-08-22T02:00:00Z',
      base: { ref: 'main' },
      head: { ref: workflow.branch },
    }
    const prComments: Array<{ author: { login: string }; body: string }> = []
    const reviews: Array<{ state: string; body: string }> = []
    const handler = createHandler(
      async (spec) => {
        const api = githubApi(spec.command, { item: currentIssue, pr, prComments, reviews })
        if (api) return api
        if (spec.command === 'git rev-parse --short HEAD')
          return { exitCode: 0, stdout: { text: 'abc123' }, stderr: { text: '' } }
        if (spec.command.includes('--method POST') && spec.command.includes('/comments')) {
          prComments.push({ author: { login: 'clickvibe' }, body: JSON.parse(spec.stdin ?? '{}').body ?? '' })
          return {
            exitCode: 0,
            stdout: { text: 'HTTP/1.1 201\n\n{"id":5,"html_url":"https://github.com/o/r/pull/29#issuecomment-5"}' },
            stderr: { text: '' },
          }
        }
        if (spec.command.includes('--method POST') && spec.command.includes('/reviews')) {
          const body = JSON.parse(spec.stdin ?? '{}').body ?? ''
          reviews.push({ state: 'APPROVED', body, commit_id: 'abc123', user: { login: 'clickvibe' } })
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":9}' }, stderr: { text: '' } }
        }
        if (spec.command.includes("'user'")) {
          return { exitCode: 0, stdout: { text: included({ login: 'clickvibe' }) }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      (spec) => {
        starts.push({ command: spec.command, prompt: spec.stdin ?? '' })
        let read = false
        return {
          status: 'running',
          exitCode: 0,
          done: (async () => {
            await mkdir(join(worktree, '.clickvibe'), { recursive: true })
            await writeFile(join(worktree, '.clickvibe', 'review-result.json'), '{"passed":true,"issues":[]}')
            await new Promise((resolve) => setTimeout(resolve, 5))
          })(),
          readOutput() {
            if (read) return { delta: '', lossy: false }
            read = true
            return { delta: '{"type":"thread.started","thread_id":"review-session"}\n', lossy: false }
          },
          kill() {
            return true
          },
        }
      },
    )
    const headers = { origin: 'same-origin', 'x-clickvibe-request': '1' }
    const userContext = '额外关注并发安全与错误处理路径'
    const authorized = (await post(
      handler,
      '/clickvibe/api/authorize',
      {
        action: 'review',
        url: workflow.url,
        agent: 'codex',
        context: userContext,
      },
      headers,
    )) as { status: number; body: { authorizationId?: string; authorizationDigest?: string } }
    const reviewed = (await post(
      handler,
      '/clickvibe/api/review',
      {
        url: workflow.url,
        agent: 'codex',
        context: userContext,
        authorizationId: authorized.body.authorizationId,
        authorizationDigest: authorized.body.authorizationDigest,
      },
      headers,
    )) as { status: number; body: { ok: boolean; taskId?: string } }
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body))
    await waitForTask(handler, reviewed.body.taskId ?? '')

    assert.equal(starts.length, 1)
    assert.match(starts[0].prompt, /请执行 ClickVibe Review阶段。/)
    assert.match(starts[0].prompt, /附加上下文:\n额外关注并发安全与错误处理路径/)
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.events.at(-1)?.kind, 'review')
    assert.equal(reloaded?.events.at(-1)?.userContext, userContext)
    assert.equal(typeof reloaded?.events.at(-1)?.durationMs, 'number')
    // 附加说明不自动发布为 GitHub 评论。
    const comments = await readLogHistory(workflow.key, 'review')
    assert.equal(
      comments.some((line) => line.includes('额外关注并发安全')),
      false,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
