import { withAssessmentPrompt } from '../src/workflow/assessment-context.ts'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { AssessmentController } from '../src/workflow/assessment.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { recoveryHome } from './helpers/recovery-home.ts'

const url = 'https://github.com/o/r/issues/177'
const model = { provider: 'scripted', model: 'test' }
const report = 'Implementation Gate: NEEDS_DECISION\nWork: o/r#177\n需要确认导出格式。'
const waitFor = async (predicate: () => Promise<boolean>) => {
  for (let n = 0; n < 1000; n++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('assessment did not settle')
}

test('one assessment flows through source, host adapter, durable report, publication, discussion and invalidation', async () => {
  const fixture = await recoveryHome(['o/r'])
  const previousHome = process.env.HOME
  process.env.HOME = fixture.home
  let calls = 0
  let posts = 0
  let unavailable = false
  let body = '## 目标\n导出清单\n## 依赖\n无'
  let updated = '2026-09-14T00:00:00Z'
  const comments: { id: number; body: string }[] = []
  const logs = new Map<string, { type: string; data: Record<string, unknown> }[]>()
  const item = () => ({
    number: 177,
    html_url: url,
    title: 'Export',
    body,
    state: 'open',
    updated_at: updated,
    user: { login: 'owner' },
    milestone: { title: 'UI' },
  })
  const host = {
    llm: { resolveCallConfig: async (value: unknown) => assert.deepEqual(value, model) },
    agents: {
      async create(options: { sessionId: string; setup(scope: unknown): void }) {
        const tools = new Map<string, { execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown> }>()
        let guard: (execution: { name: string }) => string | undefined = () => undefined
        options.setup({
          tools: {
            presentAs: (mode: string) => assert.equal(mode, 'native'),
            restrict: (value: unknown) => assert.deepEqual(value, { allow: [] }),
            guard: (fn: typeof guard) => {
              guard = fn
            },
            register: (tool: {
              name: string
              execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown>
            }) => tools.set(tool.name, tool),
          },
        })
        assert.ok(guard({ name: 'shell' }))
        assert.equal(guard({ name: 'assessment_read_file' }), undefined)
        logs.set(options.sessionId, [])
        return {
          agent: {
            id: options.sessionId,
            followup(message: { id: string; source: unknown }) {
              calls++
              logs.set(options.sessionId, [
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { ...message } },
                { type: 'step/start', data: { turn: 1 } },
                {
                  type: 'assistant/message',
                  data: { turn: 1, message: { content: [{ type: 'text', text: report }] } },
                },
                { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
              ])
            },
            async whenIdle() {
              assert.equal(
                typeof (await tools
                  .get('assessment_list_files')!
                  .execute({}, { signal: new AbortController().signal })),
                'string',
              )
            },
            cancel: () => {},
          },
          dispose: async () => {},
        }
      },
    },
    sessionPersistence: {
      flush: async () => {},
      open: async (id: string) => ({
        read: async (offset: number, length: number) => ({ events: logs.get(id)!.slice(offset, offset + length) }),
        close: async () => {},
      }),
    },
  }
  const ctx = {
    get(name: string) {
      return host[name as keyof typeof host]
    },
    effect: () => () => {},
    shell: {
      resolve: (value: unknown) => value,
      async run(spec: { command: string; stdin?: string }) {
        if (unavailable) throw new Error('network unavailable')
        assert.ok(spec.command.startsWith('gh api '), spec.command)
        let value: unknown = []
        if (spec.command.includes('--method')) {
          posts++
          const comment = { id: posts, body: JSON.parse(spec.stdin!).body }
          comments.push(comment)
          value = comment
        } else if (/\/comments/.test(spec.command)) value = comments
        else if (/\/issues\?state=all/.test(spec.command))
          value = [
            item(),
            { ...item(), number: 178, html_url: url.replace('177', '178'), state: 'closed' },
            { ...item(), pull_request: {} },
          ]
        else if (/\/issues\/177(?:\s|['"]|$)/.test(spec.command)) value = item()
        return { exitCode: 0, stdout: { text: `HTTP/2.0 200 OK\n\n${JSON.stringify(value)}` }, stderr: { text: '' } }
      },
    },
  }
  const controller = new AssessmentController(ctx as never)
  try {
    assert.deepEqual(await controller.handle({ action: 'settings', repoKey: 'o/r' }), { ok: true, setting: null })
    const targets = (await controller.handle({ action: 'targets', repoKey: 'o/r', milestone: 'UI' })) as {
      urls: string[]
    }
    assert.deepEqual(targets.urls, [url, url.replace('177', '178')])
    assert.deepEqual(await controller.handle({ action: 'automatic', repoKey: 'o/r', urls: [url] }), {
      ok: true,
      ids: [],
    })
    const ids = await controller.submit([url], model)
    await waitFor(async () =>
      (await controller.store.list()).some((run) => {
        if (run.phase === 'failed' || run.error || run.publication.error) assert.fail(JSON.stringify(run))
        return run.id === ids[0] && run.publication.status === 'published'
      }),
    )
    assert.equal(calls, 1)
    assert.equal(posts, 1)
    const prompt = await withAssessmentPrompt({
      url,
      title: 'Export',
      body,
      state: 'OPEN',
      updatedAt: updated,
      comments: [],
    })
    assert.match(prompt.comments[0].body, /NEEDS_DECISION/)
    assert.match(prompt.comments[0].body, /不构成开发前置/)
    const status = await controller.status([url])
    assert.equal(status.items[0].discussion, true)
    assert.equal(status.items[0].report?.text, report)
    assert.deepEqual(await controller.submit([url], model), ids)
    assert.equal(calls, 1)
    await controller.handle({ action: 'discussion', id: ids[0], sessionId: 'discussion' })
    assert.equal(
      (
        (await controller.handle({ action: 'discussion-context', sessionId: 'discussion' })) as {
          binding: { url: string }
        }
      ).binding.url,
      url,
    )
    await controller.handle({ action: 'configure', repoKey: 'o/r', enabled: true, model })
    await assert.rejects(
      controller.handle({ action: 'automatic', repoKey: 'o/r', urls: ['https://github.com/other/repo/issues/1'] }),
      /项目不一致/,
    )
    body += '\n已确认导出 CSV'
    updated = '2026-09-14T00:01:00Z'
    await controller.handle({ action: 'discussion-refresh', urls: [url] })
    await waitFor(
      async () => (await controller.store.list()).filter((run) => run.publication.status === 'published').length === 2,
    )
    assert.equal(calls, 2)
    assert.equal(posts, 2)
    await controller.close()
    const restored = new AssessmentController(ctx as never)
    try {
      assert.equal((await restored.status([url])).items[0].report?.text, report)
      unavailable = true
      resetGithubGatewayOwnerForTests()
      const offline = await restored.status([url])
      assert.equal(
        offline.items[0].report?.text,
        report,
        'saved report remains readable when current evidence cannot be fetched',
      )
      assert.match(offline.items[0].error ?? '', /network unavailable/)
    } finally {
      await restored.close()
    }
    await assert.rejects(controller.handle({ action: 'wat' }), /不支持/)
    await assert.rejects(controller.submit([url], {}), /模型/)
    await assert.rejects(controller.handle({ action: 'evaluate', urls: [2] }), /列表无效/)
  } finally {
    await controller.close()
    resetGithubGatewayOwnerForTests()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('automatic assessment can be disabled without a current Harness model or session', async () => {
  const { home } = await recoveryHome([])
  const previous = process.env.HOME
  process.env.HOME = home
  const controller = new AssessmentController({ get: () => undefined } as never)
  try {
    await controller.store.configure('o/r', { enabled: true, model })
    await controller.handle({ action: 'configure', repoKey: 'o/r', enabled: false })
    assert.equal((await controller.store.read()).projects['o/r'].enabled, false)
  } finally {
    await controller.close()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('missing host capability preserves accepted work and persists a visible error', async () => {
  const { home } = await recoveryHome([])
  const previous = process.env.HOME
  process.env.HOME = home
  const controller = new AssessmentController({ get: () => undefined } as never)
  try {
    await controller.store.submit([
      { url, repoKey: 'o/r', repoPath: home, title: 'Issue', body: 'Goal', basis: 'b', baseOid: 'a'.repeat(40), model },
    ])
    controller.wake()
    await waitFor(async () => !!(await controller.store.read()).error)
    assert.match((await controller.store.read()).error ?? '', /Harness 缺少/)
    assert.equal((await controller.store.list())[0].phase, 'queued')
  } finally {
    await controller.close()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid assessment storage cannot turn a background failure into an unhandled rejection or overwrite', async () => {
  const { home } = await recoveryHome([])
  const previous = process.env.HOME
  process.env.HOME = home
  const controller = new AssessmentController({ get: () => undefined } as never)
  try {
    await controller.store.configure('o/r', { enabled: false, model })
    const { writeFile, readFile } = await import('node:fs/promises')
    const path = `${home}/.clickvibe/state-recovery-1/assessments/state.json`
    await writeFile(path, '{"schema":99}')
    controller.wake()
    await waitFor(async () => !!controller.lastError?.includes('错误记录保存失败'))
    assert.equal(await readFile(path, 'utf8'), '{"schema":99}')
    await controller.close()
  } finally {
    await controller.close()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
