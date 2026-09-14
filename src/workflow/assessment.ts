/** One coordinator for advisory evaluations; never calls development authorization. */
import type { Context } from '@deepseek-ai/cordis'
import { AssessmentStore, assessmentOwnerAlive } from '../infra/assessment-store.ts'
import { assessmentBasis, assessmentGit, assessmentSkill } from '../infra/assessment-source.ts'
import { assessmentHarness, executeAssessment, readAssessmentSession } from '../infra/assessment-harness.ts'
import type { AssessmentModel, AssessmentRun } from '../infra/assessment-types.ts'
import { loadConfig, parseUrl } from '../infra/runtime.ts'
import { stateDir } from '../infra/state.ts'
import { githubRead } from '../github/operations.ts'
import { publishAssessment } from '../github/assessment-publication.ts'
import { observeCurrentIssueContract } from './work-item-contract-repository.ts'
import { readAssessmentOutput } from '../agent/assessment-output.ts'
import { assessmentReport, assessmentView } from './assessment-policy.ts'

const controllers = new WeakMap<object, AssessmentController>()
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
export function assessments(ctx: Context) {
  let controller = controllers.get(ctx)
  if (!controller) {
    controller = new AssessmentController(ctx)
    controllers.set(ctx, controller)
    ctx.effect(() => () => controller!.close(), 'clickvibe:assessments')
  }
  return controller
}
function parseModel(value: unknown): AssessmentModel {
  const model = value as AssessmentModel
  if (
    !model ||
    typeof model.provider !== 'string' ||
    !model.provider ||
    typeof model.model !== 'string' ||
    !model.model ||
    (model.reasoningEffort !== undefined && typeof model.reasoningEffort !== 'string')
  )
    throw new Error('请先在 Harness 选择可用模型')
  return {
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  }
}
export class AssessmentController {
  readonly store: AssessmentStore
  private readonly ctx: Context
  private running: Promise<void> | null = null
  private abort: AbortController | null = null
  private activeId: string | null = null
  private closed = false
  constructor(ctx: Context) {
    this.ctx = ctx
    this.store = new AssessmentStore(stateDir())
  }
  async input(url: string, model: AssessmentModel, force = false) {
    const target = parseUrl(url)
    if (!target || target.kind !== 'issue') throw new Error('评估目标必须是 GitHub Issue')
    const repoKey = `${target.owner}/${target.repo}`
    const config = await loadConfig()
    const repoPath = config.repos[repoKey]
    if (!repoPath) throw new Error('请先配置目标仓库的本机路径')
    const current = await observeCurrentIssueContract(this.ctx, url, { force })
    if (current.state !== 'known') throw new Error(current.reason)
    const baseOid = (await assessmentGit(repoPath, ['rev-parse', 'HEAD'])).trim()
    const skill = await assessmentSkill()
    return {
      url,
      repoKey,
      repoPath,
      contract: {
        goal: current.snapshot.goal,
        acceptanceCriteria: current.snapshot.acceptanceCriteria,
        nonGoals: current.snapshot.nonGoals,
        constraints: current.snapshot.constraints,
        dependencies: current.snapshot.dependencies,
        architectureImpact: current.snapshot.architectureImpact,
      },
      title: current.prompt.title,
      body: current.prompt.body,
      baseOid,
      model,
      basis: assessmentBasis(current.prompt.body, current.snapshot.fingerprint, baseOid, skill.hash),
    }
  }
  async submit(urls: string[], value: unknown, retry = false) {
    const model = parseModel(value)
    await assessmentHarness(this.ctx).llm.resolveCallConfig(model)
    const inputs = await Promise.all([...new Set(urls)].map((url) => this.input(url, model)))
    if (!inputs.length) throw new Error('没有选择评估目标')
    const runs = await this.store.submit(inputs, retry)
    this.wake()
    return runs.map((run) => run.id)
  }
  wake() {
    if (this.closed || this.running) return
    this.lastError = null
    this.running = this.drain()
      .then(async () => {
        if ((await this.store.read()).error) await this.store.rememberError()
      })
      .catch(async (error) => {
        this.lastError = errorText(error)
        await this.store.rememberError(this.lastError).catch((persistenceError) => {
          this.lastError += `; 错误记录保存失败: ${errorText(persistenceError)}`
        })
      })
      .finally(async () => {
        this.running = null
        if (!this.closed && !this.lastError) {
          try {
            const runs = await this.store.list()
            if (!runs.some((run) => run.owner) && runs.some((run) => run.phase === 'queued')) this.wake()
          } catch (error) {
            this.lastError = errorText(error)
            await this.store.rememberError(this.lastError).catch((persistenceError) => {
              this.lastError += `; 错误记录保存失败: ${errorText(persistenceError)}`
            })
          }
        }
      })
  }

  lastError: string | null = null
  private async drain() {
    const initial = await this.store.list()
    if (!initial.length) return
    const host = assessmentHarness(this.ctx)
    for (const run of initial) {
      if (!run.owner || assessmentOwnerAlive(run)) continue
      try {
        await this.store.complete(
          run,
          assessmentReport(readAssessmentOutput(await readAssessmentSession(host, run), run.messageId)),
        )
      } catch (error) {
        await this.store.fail(run, errorText(error), true)
      }
    }
    while (!this.closed) {
      const run = await this.store.claim()
      if (!run) break
      this.abort = new AbortController()
      this.activeId = run.id
      try {
        const events = await executeAssessment(host, run, (await assessmentSkill()).text, this.abort.signal)
        await this.store.complete(run, assessmentReport(readAssessmentOutput(events, run.messageId)))
      } catch (error) {
        await this.store.fail(run, errorText(error))
      } finally {
        this.abort = null
        this.activeId = null
      }
      const settled = (await this.store.list()).find((item) => item.id === run.id)!
      await this.publish(settled)
    }
    for (const run of await this.store.list())
      if (run.phase === 'completed' && run.publication.status === 'pending') await this.publish(run)
  }
  private async publish(run: AssessmentRun) {
    if (run.phase !== 'completed') return
    try {
      const report = await this.store.report(run)
      if (report) await publishAssessment(this.ctx, this.store, run, report)
    } catch (error) {
      const current = (await this.store.list()).find((item) => item.id === run.id)!
      await this.store.publication(run.id, current.publication.status, {
        ...current.publication,
        error: errorText(error),
      })
    }
  }
  async cancel(id: string) {
    await this.store.cancel(id)
    if (id === this.activeId) this.abort?.abort()
  }
  async close() {
    this.closed = true
    this.abort?.abort()
    await this.running
  }
  async status(urls: string[]) {
    const state = await this.store.read()
    const results = await Promise.all(
      urls.map(async (url) => {
        const run = [...state.runs].reverse().find((item) => item.input.url === url)
        if (!run) return { url, label: '未评估', discussion: false }
        let report: Awaited<ReturnType<AssessmentStore['report']>>
        try {
          report = await this.store.report(run)
        } catch (error) {
          return { url, id: run.id, label: '评估报告读取失败', discussion: false, error: errorText(error) }
        }
        const saved = {
          url,
          id: run.id,
          phase: run.phase,
          report,
          publication: run.publication,
          repoPath: run.input.repoPath,
        }
        try {
          const input = await this.input(url, run.input.model)
          return { ...saved, ...assessmentView(run, input.basis), error: run.error }
        } catch (error) {
          return { ...saved, label: '评估依据读取失败（保留历史报告）', discussion: false, error: errorText(error) }
        }
      }),
    )
    this.wake()
    return { ok: true, items: results, error: this.lastError ?? state.error }
  }
  async handle(payload: unknown) {
    const body = payload as {
      action?: string
      urls?: string[]
      model?: unknown
      id?: string
      sessionId?: string
      url?: string
      repoKey?: string
      enabled?: boolean
      milestone?: string
    }
    const urls = body?.urls
    if (urls && (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')))
      throw new Error('评估目标列表无效')
    switch (body?.action) {
      case 'status':
        return this.status(urls ?? [])
      case 'settings':
        return { ok: true, setting: (await this.store.read()).projects[String(body.repoKey)] ?? null }
      case 'automatic': {
        const setting = (await this.store.read()).projects[String(body.repoKey)]
        if (!setting?.enabled) return { ok: true, ids: [] }
        const parsed = (urls ?? []).map((url) => parseUrl(url))
        if (parsed.some((target) => !target || `${target.owner}/${target.repo}` !== body.repoKey))
          throw new Error('自动评估目标与项目不一致')
        return { ok: true, ids: await this.submit(urls ?? [], setting.model) }
      }
      case 'targets': {
        if (!body.repoKey || !(await loadConfig()).repos[body.repoKey]) throw new Error('项目未配置')
        const snapshot = (await githubRead(this.ctx, {
          operation: 'repo-snapshot',
          repoKey: body.repoKey,
          consistency: 'upstream-confirmed',
        })) as { issues: { html_url: string; pull_request?: unknown; milestone?: { title: string } | null }[] }
        return {
          ok: true,
          urls: snapshot.issues
            .filter((item) => !item.pull_request && (item.milestone?.title ?? '无里程碑') === body.milestone)
            .map((item) => item.html_url),
        }
      }
      case 'discussion-refresh': {
        const state = await this.store.read()
        for (const binding of Object.values(state.discussions)) {
          if (!(urls ?? []).includes(binding.url)) continue
          const run = state.runs.find((item) => item.id === binding.runId)
          if (!run) continue
          const input = await this.input(binding.url, run.input.model, true)
          if (input.body !== binding.body && input.basis !== run.input.basis)
            await this.submit([binding.url], run.input.model)
        }
        return { ok: true }
      }
      case 'evaluate':
        return { ok: true, ids: await this.submit(urls ?? [], body.model) }
      case 'retry':
        return { ok: true, ids: await this.submit(urls ?? [], body.model, true) }
      case 'cancel':
        await this.cancel(String(body.id))
        return { ok: true }
      case 'publish': {
        const run = (await this.store.list()).find((item) => item.id === body.id)
        if (!run) throw new Error('评估记录不存在')
        if (run.publication.status === 'failed') {
          await this.store.publication(run.id, 'failed', { status: 'pending' })
          run.publication = { status: 'pending' }
        }
        await this.publish(run)
        return { ok: true }
      }
      case 'discussion': {
        const run = (await this.store.list()).find((item) => item.id === body.id)
        if (!run || !body.sessionId) throw new Error('讨论关联无效')
        await this.store.discuss(body.sessionId, { url: run.input.url, runId: run.id, body: run.input.body })
        return { ok: true }
      }
      case 'discussion-context':
        return { ok: true, binding: (await this.store.read()).discussions[String(body.sessionId)] ?? null }
      case 'configure': {
        if (!body.repoKey) throw new Error('请选择项目')
        if (body.enabled !== true) {
          const previous = (await this.store.read()).projects[body.repoKey]
          if (previous) await this.store.configure(body.repoKey, { ...previous, enabled: false })
        } else {
          const model = parseModel(body.model)
          await assessmentHarness(this.ctx).llm.resolveCallConfig(model)
          await this.store.configure(body.repoKey, { enabled: true, model })
        }
        return { ok: true }
      }
      default:
        throw new Error('不支持的评估动作')
    }
  }
}
