import { assertAutomaticRunAdmission } from '../infra/recovery-budget.ts'
import { ShellCommandError } from '../infra/shell-failure.ts'
import { workflowSeed } from '../infra/workflow-seed.ts'
/** ADR-0016: worktree writes and their durable intent share one workflow command domain. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, constants, mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch } from '../infra/remote-git.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { buildWorktreeAddCommand, decideWorktreeRecovery, shellQuote } from '../infra/develop-core.ts'
import { expandHome, loadConfig, runCommand, type ClickVibeConfig } from '../infra/runtime.ts'
import { appendLog, type IssueWorkflow, issueKey, stateDir } from '../infra/state.ts'
import { observeWorkflowTask, preparationBlockReason, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { withWorkflowPreparationCommand } from '../infra/workflow-persistence.ts'
import { validPreparation, type PreparationTransaction, type WorktreePreparation } from '../infra/preparation-record.ts'
import { runtimeIdentity } from '../infra/task-diagnostics.ts'
import { resolveSelectedRemoteBase } from './baseline.ts'

type ParsedIssue = { owner: string; repo: string; number: string }
type PreparedResult =
  | { ok: true; workflow: IssueWorkflow; worktree: string; branch: string }
  | { ok: false; error: string }
// A settled local command may be recovered after a disk error. A restarted process has no such proof.
const endedCommands = new Map<string, true>()

export async function ensureWorktree(
  ctx: Context,
  parsed: ParsedIssue,
  requestedBaseline?: unknown,
  authorizedTaskStateRevision?: number,
  autoRunId?: string,
): Promise<PreparedResult> {
  let config: ClickVibeConfig
  try {
    config = await loadConfig()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const repo = config.repos[repoKey]
  if (!repo) return { ok: false, error: `本地未配置仓库 ${repoKey}` }
  const expandedRepo = expandHome(repo)
  if (!existsSync(expandedRepo)) return { ok: false, error: `仓库路径不存在: ${expandedRepo}` }
  await remoteFetch(ctx, {
    repoKey,
    workdir: expandedRepo,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: expandedRepo },
    timeoutMs: 60_000,
  })
  const seed = workflowSeed(repoKey, parsed.number, expandedRepo, config.worktreeRoot)
  try {
    return await withWorkflowPreparationCommand(seed, (transaction) =>
      prepare(
        ctx,
        parsed,
        config,
        expandedRepo,
        seed,
        transaction,
        requestedBaseline,
        authorizedTaskStateRevision,
        autoRunId,
      ),
    )
  } catch (error) {
    return {
      ok: false,
      error: `工作区准备或持久锁失败，现场已保留: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function prepare(
  ctx: Context,
  parsed: ParsedIssue,
  config: ClickVibeConfig,
  repo: string,
  seed: IssueWorkflow,
  transaction: PreparationTransaction,
  requestedBaseline: unknown,
  authorizedTaskStateRevision?: number,
  autoRunId?: string,
): Promise<PreparedResult> {
  let workflow = transaction.current() ?? seed
  assertAutomaticRunAdmission(workflow, autoRunId, Date.now())
  const revision = workflow.taskStateRevision ?? 0
  if (
    (authorizedTaskStateRevision !== undefined && authorizedTaskStateRevision !== revision) ||
    (workflow.devInterrupted && authorizedTaskStateRevision === undefined)
  )
    return { ok: false, error: '启动授权对应的任务代次已变化或已停止，请重新授权' }
  const blocked = preparationBlockReason(ctx as unknown as TaskOwnershipContext, workflow)
  if (blocked) return { ok: false, error: blocked }
  const ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow)
  if (ownership.state === 'running' || ownership.state === 'unknown')
    return { ok: false, error: '工作区准备被当前任务占用或归属未知阻止' }
  if (JSON.stringify(await loadConfig()) !== JSON.stringify(config))
    return { ok: false, error: '仓库配置已变化，请重新授权' }
  const { worktree, branch } = seed
  const target = await canonicalWorktreePath(worktree)
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repo }
  const deadline = Date.now() + 120_000
  const workItem = { provider: 'github', instance: 'github.com', container: seed.repoKey, id: parsed.number }
  const command = async (text: string, workdir = repo, operation = 'worktree-observe') => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('worktree preparation deadline exceeded')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        runCommand(ctx, text, {
          workdir,
          sandboxPolicy: policy,
          timeoutMs: Math.min(60_000, remaining),
          signal: controller.signal,
          diagnostic: { operation, workItem, root: stateDir(), maxBytes: config.diagnosticsMaxBytes },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('worktree preparation deadline exceeded; command outcome unknown'))
          }, remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const common = await command('git rev-parse --git-common-dir', repo, 'worktree-common-dir')
  const commonDir = await realpath(resolve(repo, common))
  let prior = workflow.preparation
  if (
    prior &&
    prior.taskStateRevision !== revision &&
    authorizedTaskStateRevision === revision &&
    ['prepared', 'settled', 'verified'].includes(prior.status)
  )
    prior = { ...prior, taskStateRevision: revision }
  if (
    prior &&
    (!validPreparation(prior) ||
      prior.status === 'blocked' ||
      prior.taskStateRevision !== (workflow.taskStateRevision ?? 0) ||
      prior.worktree !== target ||
      prior.branch !== branch ||
      prior.commonDir !== commonDir)
  )
    return { ok: false, error: 'worktree preparation 无法证明现场归属；保留并等待人工重新授权' }
  if (
    prior?.status === 'dispatched' &&
    (prior.runtimeInstanceId !== runtimeIdentity.runtimeInstanceId || !endedCommands.has(prior.attemptId))
  )
    return { ok: false, error: 'worktree preparation 命令结束未知；保留现场，禁止重放' }
  let defaultBase = await command(
    'git symbolic-ref --quiet --short refs/remotes/origin/HEAD',
    repo,
    'worktree-default-base',
  ).catch(() => '')
  if (!defaultBase) {
    if (
      (
        await command("git show-ref --verify --quiet 'refs/remotes/origin/main'; echo $?", repo, 'worktree-main-exists')
      ).trim() !== '0'
    )
      return { ok: false, error: '无法确定 origin 默认分支,请设置 origin/HEAD' }
    defaultBase = 'origin/main'
  }
  let remoteBase: string
  try {
    remoteBase = resolveSelectedRemoteBase({
      requested: requestedBaseline,
      frozen: workflow.baseRef ?? (prior ? `${prior.baseRef} @ ${prior.baseOid}` : null),
      defaultRemoteBase: defaultBase,
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const first = !workflow.baseRef
  if (first && remoteBase === `origin/${branch}`)
    return { ok: false, error: `开发基线不能选择当前 Issue 开发分支 ${remoteBase}` }
  const baseExists =
    (
      await command(
        `git show-ref --verify --quiet ${shellQuote(`refs/remotes/${remoteBase}`)}; echo $?`,
        repo,
        'worktree-base-exists',
      )
    ).trim() === '0'
  if (first && !baseExists && !prior) return { ok: false, error: `开发基线不存在或未 fetch: ${remoteBase}` }
  const baseOid =
    prior?.baseOid ??
    (first
      ? await command(`git rev-parse ${shellQuote(remoteBase)}`, repo, 'worktree-base-oid')
      : workflow.baseRef!.split(' @ ')[1])
  // Old frozen baselines can contain short OIDs; expand through Git before persisting new authority.
  const fullBase = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseOid ?? '')
    ? baseOid!
    : await command(`git rev-parse ${shellQuote(baseOid || remoteBase)}`, repo, 'worktree-base-oid')
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fullBase))
    return { ok: false, error: `无法读取开发基线提交: ${remoteBase}` }
  const observeRegistrations = async () =>
    Promise.all(
      parseWorktreeList(await command('git worktree list --porcelain', repo, 'worktree-list')).map(async (entry) => ({
        ...entry,
        path: await canonicalWorktreePath(entry.path),
      })),
    )
  const records = await observeRegistrations()
  const atPath = records.find((r) => r.path === target)
  const atBranch = records.find((r) => r.branch === branch)
  const pathExists = existsSync(target)
  const pathEmpty = pathExists && (await readdir(target)).length === 0
  const branchExists =
    (
      await command(
        `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; echo $?`,
        repo,
        'worktree-branch-exists',
      )
    ).trim() === '0'
  const recovery = decideWorktreeRecovery({
    targetBranch: branch,
    pathExists,
    pathEmpty,
    registeredBranch: atPath?.branch ?? null,
    branchExists,
    branchWorktree: atBranch?.path ?? null,
  })
  if (recovery.kind === 'conflict') {
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 冲突: ${recovery.reason}`)
    return { ok: false, error: `worktree 冲突: ${recovery.reason}` }
  }
  const oldHead = branchExists
    ? await command(`git rev-parse ${shellQuote(`refs/heads/${branch}`)}`, repo, 'worktree-branch-head')
    : atPath?.branch === 'HEAD'
      ? await command('git rev-parse HEAD', target, 'worktree-head')
      : fullBase
  if (first && (branchExists || recovery.kind === 'attach-detached') && !prior) {
    if (requestedBaseline !== undefined && requestedBaseline !== null && remoteBase !== defaultBase)
      return {
        ok: false,
        error: `既有开发分支 ${branch} 缺少冻结基线记录,无法证明从所选基线创建;拒绝定格或暗改 worktree`,
      }
    const compatible = await command(
      `git merge-base --is-ancestor ${shellQuote(fullBase)} ${shellQuote(oldHead)}`,
    ).then(
      () => true,
      () => false,
    )
    if (!compatible) return { ok: false, error: `既有开发分支 ${branch} 不包含所选基线 ${remoteBase}` }
  }
  const expectedHead = prior && prior.status !== 'verified' ? prior.expectedHead : oldHead
  let record: WorktreePreparation =
    prior && prior.status !== 'verified'
      ? prior
      : {
          schema: 1,
          attemptId: randomUUID(),
          runtimeInstanceId: runtimeIdentity.runtimeInstanceId,
          taskStateRevision: workflow.taskStateRevision ?? 0,
          commonDir,
          worktree: target,
          branch,
          baseRef: remoteBase,
          baseOid: fullBase,
          expectedHead,
          status: 'prepared',
        }
  const persist = async (status: WorktreePreparation['status'], baseRef?: string) => {
    record = { ...record, status }
    workflow = await transaction.commit({ preparation: record, worktree, branch, ...(baseRef ? { baseRef } : {}) })
  }
  const readback = async () => {
    const registered = (await observeRegistrations()).find((r) => r.path === target)
    if (
      registered?.branch !== branch ||
      (await command('git rev-parse HEAD', target, 'worktree-head')) !== expectedHead
    )
      throw new Error('worktree preparation Git 回读不符；保留现场')
    if (prior && prior.status !== 'verified' && (await command('git status --porcelain', target, 'worktree-status')))
      throw new Error('worktree preparation 现场出现额外改动；保留现场')
  }
  const write = async (text: string, workdir: string, operation: string) => {
    assertAutomaticRunAdmission(workflow, autoRunId, Date.now())
    endedCommands.delete(record.attemptId)
    await persist('dispatched')
    await command(text, workdir, operation)
    endedCommands.set(record.attemptId, true)
    notifyLocalGitMutation({ repoKey: seed.repoKey, worktreePath: target }, 'worktree-mutation', 'ensureWorktree')
    await persist('settled')
  }
  try {
    if (prior && prior.status !== 'prepared' && prior.status !== 'verified') {
      await readback()
    } else {
      await persist('prepared')
      if (recovery.kind !== 'reuse') {
        const hookWorkdir = recovery.kind === 'attach-detached' || recovery.kind === 'attach-existing' ? target : repo
        const hooks = await command('git rev-parse --git-path hooks', hookWorkdir, 'worktree-hooks')
        if (!isAbsolute(hooks) && hooks !== '.git/hooks')
          throw new Error('相对 Git hooks 路径无法证明新工作区没有后台写入；请人工确认')
        if (!hooks) throw new Error('无法确认 Git hooks；保留现场')
        const hook = join(isAbsolute(hooks) ? hooks : resolve(hookWorkdir, hooks), 'post-checkout')
        let executable = false
        try {
          await access(hook, constants.X_OK)
          executable = true
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
        if (executable) throw new Error('post-checkout hook 可能产生后台写入；需人工确认')
        if (recovery.kind === 'attach-detached')
          await write(`git switch -c ${shellQuote(branch)}`, target, 'worktree-attach')
        else if (recovery.kind === 'attach-existing')
          await write(`git switch ${shellQuote(branch)}`, target, 'worktree-attach')
        else {
          if (recovery.kind === 'repair') {
            if (existsSync(target) && (await readdir(target)).length > 0)
              throw new Error('stale worktree 已变为非空，拒绝删除')
            if (pathExists && pathEmpty) await rmdir(target)
            await write(`git worktree remove --force ${shellQuote(target)}`, repo, 'worktree-repair').catch(
              async (error) => {
                if (!(error instanceof ShellCommandError) || error.classification !== 'command-failure') throw error
                if (
                  (await observeRegistrations()).some((entry) => entry.path === target) ||
                  (existsSync(target) && (await readdir(target)).length > 0)
                )
                  throw error
                endedCommands.set(record.attemptId, true)
                await persist('settled')
              },
            )
          }
          if (!baseExists && !branchExists) throw new Error(`基线分支已不存在: ${remoteBase}`)
          await mkdir(dirname(target), { recursive: true })
          await write(
            buildWorktreeAddCommand({
              path: target,
              branch,
              branchExists: recovery.kind === 'add-existing-branch' || (recovery.kind === 'repair' && branchExists),
              remoteBase: fullBase,
            }),
            repo,
            'worktree-add',
          )
        }
      }
      await readback()
    }
    await persist('verified', workflow.baseRef ?? `${remoteBase} @ ${fullBase}`)
    endedCommands.delete(record.attemptId)
    await appendLog(workflow.key, 'dev', '[clickvibe] worktree 已验证，现场保留')
    return { ok: true, workflow, worktree, branch }
  } catch (error) {
    // Keep the durable last state and Git facts; never roll back a completed external write.
    return {
      ok: false,
      error: `无法定格开发基线或准备工作区，现场已保留: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
/** Parse `git worktree list --porcelain` output into { path, branch } records. */
export function parseWorktreeList(output: string): { path: string; branch: string | null }[] {
  const records: { path: string; branch: string | null }[] = []
  let current: { path: string; branch: string | null } | null = null
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) {
        records.push(current)
        current = null
      }
      continue
    }
    if (trimmed.startsWith('worktree ')) {
      current = { path: trimmed.slice('worktree '.length), branch: null }
    } else if (trimmed.startsWith('branch ') && current) {
      current.branch = trimmed.slice('branch refs/heads/'.length)
    } else if (trimmed.startsWith('detached') && current) {
      current.branch = 'HEAD'
    }
  }
  if (current) records.push(current)
  return records
}

async function canonicalWorktreePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalWorktreePath(parent), basename(path))
  }
}
