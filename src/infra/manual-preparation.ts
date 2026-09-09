/** ADR-0018 offline runbook helper. Never mounted in the host; no Git writes or automatic dispatch. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { hostname, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { loadRecoveryConfig, readRecoveryAuthority } from './recovery-config.ts'
import { recoveryStateRoot } from './recovery-layout.ts'
import { parseIssueKey, workflowPath } from './state-layout.ts'
import { validPreparation } from './preparation-record.ts'
import { isRecoveryBudget } from './recovery-budget.ts'
import { isAutoRunState } from './contracts.ts'
import type { IssueWorkflow } from './state.ts'
import { durableWriteExclusive, durableWriteReplace, syncDirectory } from './v02-upgrade-durable.ts'
const exec = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export async function readBootIdentity(): Promise<string> {
  const boot =
    platform() === 'linux'
      ? await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      : platform() === 'darwin'
        ? (await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout
        : ''
  if (!boot.trim()) throw new Error('unsupported boot evidence platform')
  return hash(`${hostname()}\n${boot.trim()}`)
}
async function regular(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077)
    throw new Error('expected independent private regular file')
  return readFile(path, 'utf8')
}
async function evidenceAt(path: string) {
  const bytes = await regular(path),
    value = JSON.parse(bytes)
  if (
    !/^([a-f0-9]{64})$/.test(value.beforeBoot) ||
    value.beforeBoot === value.afterBoot ||
    value.afterBoot !== (await readBootIdentity()) ||
    !['allWritersStopped', 'restartDisabled', 'localStandardGitOnly', 'exclusiveWindow', 'backupComplete'].every(
      (k) => value[k] === true,
    ) ||
    ![value.operator, value.reason].every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500)
  )
    throw new Error('incomplete reboot/maintenance evidence; keep paused')
  return { value, hash: hash(bytes) }
}
function candidate(old: IssueWorkflow, evidence: Awaited<ReturnType<typeof evidenceAt>>, at: string, oldHash: string) {
  const p = old.preparation
  if (
    !validPreparation(p) ||
    !['dispatched', 'blocked'].includes(p.status) ||
    !Number.isSafeInteger(old.revision) ||
    old.revision! < 0 ||
    old.revision! >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(old.taskStateRevision) ||
    old.taskStateRevision! < 0 ||
    old.taskStateRevision! >= Number.MAX_SAFE_INTEGER ||
    old.devTaskId ||
    old.reviewTaskId ||
    old.devHostJobId ||
    old.reviewHostJobId ||
    old.prCreate ||
    old.delivery ||
    Object.keys(old.remoteGitAttempts ?? {}).length ||
    !Array.isArray(old.events) ||
    !isAutoRunState(old.autoRun) ||
    (old.autoRun && !isRecoveryBudget(old.autoRun.recoveryBudget))
  )
    throw new Error('unresolved authority or invalid preparation; manual settlement refused')
  if (!Number.isFinite(Date.parse(at))) throw new Error('invalid settlement timestamp')
  const next = structuredClone(old)
  next.revision = old.revision! + 1
  next.taskStateRevision = old.taskStateRevision! + 1
  next.preparation = { ...p, status: 'settled', taskStateRevision: next.taskStateRevision }
  next.devInterrupted = true
  if (next.autoRun) {
    next.autoRun.status = 'paused'
    next.autoRun.pausedReason = 'session-interrupted'
  }
  next.updatedAt = Date.parse(at)
  next.events.push({
    kind: 'note',
    at,
    operator: evidence.value.operator,
    note: `manual preparation ${p.attemptId}: ${p.status} -> settled; original=${oldHash}; evidence=${evidence.hash}`,
    reason: evidence.value.reason,
  })
  return next
}
async function inspect(home: string, old: IssueWorkflow) {
  const authority = hash(JSON.stringify(readRecoveryAuthority(home)))
  const config = await loadRecoveryConfig(home),
    parsed = parseIssueKey(old.key),
    p = old.preparation!
  if (
    !parsed ||
    old.repoKey !== `${parsed.owner}/${parsed.repo}` ||
    old.url !== `https://github.com/${old.repoKey}/issues/${parsed.issue}` ||
    !config.repos[old.repoKey]
  )
    throw new Error('workflow identity mismatch')
  const repo = config.repos[old.repoKey]
  const target = join(config.worktreeRoot, basename(repo), `${basename(repo)}-issue-${parsed.issue}`)
  if (
    old.branch !== `${basename(repo)}-issue-${parsed.issue}` ||
    old.worktree !== target ||
    p.branch !== old.branch ||
    (await realpath(target)) !== p.worktree ||
    (old.baseRef && old.baseRef !== `${p.baseRef} @ ${p.baseOid}`)
  )
    throw new Error('preparation target/baseline mismatch')
  const git = async (cwd: string, ...args: string[]) => {
    try {
      return (
        await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
          env: { PATH: process.env.PATH, HOME: home, LC_ALL: 'C' },
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout.trim()
    } catch {
      throw new Error('Git scene unavailable; keep paused')
    }
  }
  const common = await realpath(resolve(target, await git(target, 'rev-parse', '--git-common-dir')))
  if (
    common !== p.commonDir ||
    common !== (await realpath(resolve(repo, await git(repo, 'rev-parse', '--git-common-dir'))))
  )
    throw new Error('Git common directory mismatch')
  const head = await git(target, 'rev-parse', 'HEAD')
  if (head !== p.expectedHead || (await git(target, 'symbolic-ref', 'HEAD')) !== `refs/heads/${p.branch}`)
    throw new Error('Git head/branch mismatch')
  if ((await git(repo, 'rev-parse', `${p.baseOid}^{commit}`)) !== p.baseOid) throw new Error('base object unavailable')
  if (await git(target, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('dirty Git scene')
  for (const name of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-apply',
    'rebase-merge',
    'sequencer',
  ]) {
    const path = resolve(target, await git(target, 'rev-parse', '--git-path', name))
    try {
      await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error('Git operation in progress')
  }
  const hooks = await git(target, 'rev-parse', '--git-path', 'hooks')
  if (!isAbsolute(hooks) && hooks !== '.git/hooks') throw new Error('relative hooks cannot be proven safe')
  try {
    await access(join(resolve(target, hooks), 'post-checkout'), constants.X_OK)
    throw new Error('active post-checkout hook')
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  const registrations = await git(repo, 'worktree', 'list', '--porcelain', '-z')
  const entries = registrations.split('\0\0').map((entry) => entry.split('\0'))
  const branchEntries = entries.filter((entry) => entry.includes(`branch refs/heads/${p.branch}`))
  const registeredPath = branchEntries[0]?.find((field) => field.startsWith('worktree '))?.slice(9)
  if (branchEntries.length !== 1 || !registeredPath || (await realpath(registeredPath)) !== p.worktree)
    throw new Error('Git registration conflict')
  const root = recoveryStateRoot(home),
    path = workflowPath(root, old)
  for (let directory = dirname(path); directory !== root; directory = dirname(directory)) {
    if (
      directory === dirname(directory) ||
      !(await lstat(directory)).isDirectory() ||
      (await lstat(directory)).isSymbolicLink()
    )
      throw new Error('invalid state directory')
  }
  return { path, authority, scene: hash(JSON.stringify({ common, head, registrations, hooks })) }
}

export async function previewManualPreparation(input: {
  home: string
  key: string
  evidence: string
  directory: string
}) {
  const { home, key, directory } = input
  if (![home, directory, input.evidence].every(isAbsolute)) throw new Error('absolute paths required')
  const evidence = await evidenceAt(input.evidence)
  const id = parseIssueKey(key)
  if (!id) throw new Error('invalid workflow key')
  const original = await regular(
    workflowPath(recoveryStateRoot(home), {
      key,
      repoKey: `${id.owner}/${id.repo}`,
      url: `https://github.com/${id.owner}/${id.repo}/issues/${id.issue}`,
    }),
  )
  const old = JSON.parse(original) as IssueWorkflow
  if (old.key !== key) throw new Error('workflow key mismatch')
  const at = new Date().toISOString(),
    next = candidate(old, evidence, at, hash(original))
  const observed = await inspect(home, old)
  const target = JSON.stringify(next, null, 2)
  const manifest = JSON.stringify({
    home,
    key,
    at,
    oldHash: hash(original),
    newHash: hash(target),
    evidenceHash: evidence.hash,
    ...observed,
  })
  await mkdir(directory, { mode: 0o700 })
  await durableWriteExclusive(join(directory, 'original.json'), original)
  await durableWriteExclusive(join(directory, 'target.json'), target)
  await durableWriteExclusive(join(directory, 'manifest.json'), manifest)
  await syncDirectory(dirname(directory))
  return hash(manifest)
}

export async function publishManualPreparation(directory: string, fingerprint: string, evidencePath: string) {
  const bytes = await regular(join(directory, 'manifest.json'))
  if (hash(bytes) !== fingerprint) throw new Error('manual settlement fingerprint mismatch')
  const m = JSON.parse(bytes),
    evidence = await evidenceAt(evidencePath)
  const original = await regular(join(directory, 'original.json')),
    target = await regular(join(directory, 'target.json'))
  const old = JSON.parse(original) as IssueWorkflow
  if (
    old.key !== m.key ||
    hash(original) !== m.oldHash ||
    hash(target) !== m.newHash ||
    evidence.hash !== m.evidenceHash ||
    !isDeepStrictEqual(JSON.parse(target), candidate(old, evidence, m.at, m.oldHash))
  )
    throw new Error('unapproved settlement difference')
  const check = async () => {
    const observed = await inspect(m.home, old)
    if (observed.path !== m.path || observed.authority !== m.authority || observed.scene !== m.scene)
      throw new Error('authority or Git scene drift')
    if ((await evidenceAt(evidencePath)).hash !== m.evidenceHash) throw new Error('evidence drift')
    return regular(observed.path)
  }
  const current = await check()
  if (current === target) {
    await syncDirectory(dirname(m.path))
    return
  }
  if (current !== original) throw new Error('workflow drift; keep paused')
  await durableWriteReplace(m.path, target, async (checkpoint) => {
    if (checkpoint === `before-replace:${m.path}` && (await check()) !== original) throw new Error('workflow drift')
  })
  if ((await check()) !== target) throw new Error('settlement readback mismatch')
}
