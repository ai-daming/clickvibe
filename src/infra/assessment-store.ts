/** One advisory-assessment state file, serialized with the existing active-root fence. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLinkLock } from './link-lock.ts'
import { assertActiveStateWriteAllowed } from './v02-generation-fence.ts'
import { durableWriteExclusive, durableWriteReplace, ensureDurableDirectory } from './v02-upgrade-durable.ts'
import type { AssessmentInput, AssessmentReport, AssessmentRun, AssessmentState } from './assessment-types.ts'
export const assessmentHash = (text: string) => createHash('sha256').update(text).digest('hex')
export function assessmentOwnerAlive(run: AssessmentRun): boolean {
  if (!run.owner) return false
  try {
    process.kill(run.owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export class AssessmentStore {
  readonly directory: string
  private readonly path: string
  private readonly root: string
  constructor(root: string) {
    this.root = root
    this.directory = join(root, 'assessments')
    this.path = join(this.directory, 'state.json')
  }
  async read(): Promise<AssessmentState> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schema: 1, revision: 0, runs: [], projects: {}, discussions: {} }
      throw error
    }
    const state = JSON.parse(text) as AssessmentState
    if (
      state.schema !== 1 ||
      !Number.isSafeInteger(state.revision) ||
      !Array.isArray(state.runs) ||
      !state.projects ||
      !state.discussions ||
      state.runs.some((run) => !/^[a-f0-9-]{36}$/.test(run.id) || !run.input?.basis || !run.publication)
    )
      throw new Error('评估记录格式不可用，保留原文件')
    return state
  }
  private async change<T>(fn: (state: AssessmentState) => T): Promise<T> {
    assertActiveStateWriteAllowed(this.root)
    await ensureDurableDirectory(this.directory)
    const unlock = await acquireLinkLock(this.path)
    try {
      assertActiveStateWriteAllowed(this.root)
      const state = await this.read()
      const result = fn(state)
      state.revision++
      await durableWriteReplace(this.path, JSON.stringify(state))
      return structuredClone(result)
    } finally {
      await unlock()
    }
  }
  rememberError(error?: string) {
    return this.change((state) => {
      state.error = error
    })
  }
  async list() {
    return (await this.read()).runs
  }
  submit(inputs: AssessmentInput[], retry = false): Promise<AssessmentRun[]> {
    return this.change((state) =>
      inputs.map((input) => {
        const prior = [...state.runs]
          .reverse()
          .find(
            (run) =>
              run.input.url === input.url &&
              run.input.basis === input.basis &&
              (['queued', 'running'].includes(run.phase) || !retry),
          )
        if (prior) return prior
        const run: AssessmentRun = {
          id: randomUUID(),
          input,
          sessionId: randomUUID(),
          messageId: randomUUID(),
          phase: 'queued',
          owner: null,
          publication: { status: 'pending' },
        }
        state.runs.push(run)
        return run
      }),
    )
  }
  claim(): Promise<AssessmentRun | null> {
    return this.change((state) => {
      if (state.runs.some((run) => run.owner !== null)) return null
      const run = state.runs.find((run) => run.phase === 'queued')
      if (!run) return null
      run.phase = 'running'
      run.owner = { pid: process.pid, token: randomUUID() }
      return run
    })
  }
  private owned(state: AssessmentState, claimed: AssessmentRun) {
    const run = state.runs.find((item) => item.id === claimed.id)
    if (!run || !claimed.owner || run.owner?.token !== claimed.owner.token) throw new Error('评估运行 owner 已变化')
    return run
  }
  async complete(claimed: AssessmentRun, report: AssessmentReport): Promise<void> {
    const text = JSON.stringify(report)
    const hash = assessmentHash(text)
    assertActiveStateWriteAllowed(this.root)
    const path = join(this.directory, `${claimed.id}-${hash}.json`)
    try {
      await durableWriteExclusive(path, text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (assessmentHash(await readFile(path, 'utf8')) !== hash) throw new Error('评估报告回读不一致')
    await this.change((state) => {
      const run = this.owned(state, claimed)
      if (run.phase !== 'running') throw new Error('评估运行已取消 cancelled')
      run.phase = 'completed'
      run.reportHash = hash
      run.verdict = report.verdict
      run.owner = null
    })
  }
  async report(run: AssessmentRun): Promise<AssessmentReport | null> {
    if (!run.reportHash) return null
    if (!/^[a-f0-9]{64}$/.test(run.reportHash) || !/^[a-f0-9-]{36}$/.test(run.id)) throw new Error('评估报告引用无效')
    const text = await readFile(join(this.directory, `${run.id}-${run.reportHash}.json`), 'utf8')
    if (assessmentHash(text) !== run.reportHash) throw new Error('评估报告完整性校验失败')
    return JSON.parse(text) as AssessmentReport
  }
  fail(claimed: AssessmentRun, error: string, interrupted = false) {
    return this.change((state) => {
      const run = this.owned(state, claimed)
      if (run.phase !== 'cancelled') run.phase = interrupted ? 'interrupted' : 'failed'
      run.error = error
      run.owner = null
    })
  }
  cancel(id: string) {
    return this.change((state) => {
      const run = state.runs.find((item) => item.id === id)
      if (run && ['queued', 'running'].includes(run.phase)) run.phase = 'cancelled'
    })
  }
  publication(id: string, expected: AssessmentRun['publication']['status'], publication: AssessmentRun['publication']) {
    return this.change((state) => {
      const run = state.runs.find((item) => item.id === id)
      if (!run || run.phase !== 'completed' || run.publication.status !== expected)
        throw new Error('评估发布状态已变化')
      run.publication = publication
    })
  }
  configure(repoKey: string, setting: AssessmentState['projects'][string]) {
    return this.change((state) => {
      state.projects[repoKey] = setting
    })
  }
  discuss(sessionId: string, binding: AssessmentState['discussions'][string]) {
    return this.change((state) => {
      const old = state.discussions[sessionId]
      if (old && old.url !== binding.url) throw new Error('讨论会话已绑定其他 Issue')
      state.discussions[sessionId] = binding
    })
  }
}
