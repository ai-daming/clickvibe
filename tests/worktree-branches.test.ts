import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureWorktree } from '../src/agent/worktree.ts'
import { issueKey, loadWorkflow, saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'

interface Scenario {
  records?: string | ((target: string, branch: string) => string)
  path?: 'missing' | 'empty' | 'nonempty'
  branchExists?: boolean
  remoteExists?: boolean
  symbolicRef?: string | null
  mainExists?: boolean
  baseHash?: string
  failRemove?: boolean
  frozenBase?: string
}

async function runScenario(number: string, scenario: Scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-worktree-branches-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  const target = join(worktreeRoot, 'repo', `repo-issue-${number}`)
  const previousHome = process.env.HOME
  process.env.HOME = home
  await mkdir(join(home, '.clickvibe'), { recursive: true })
  await mkdir(repo, { recursive: true })
  await writeFile(
    join(home, '.clickvibe', 'config.yaml'),
    ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${worktreeRoot}`, ''].join('\n'),
  )
  if (scenario.path === 'empty' || scenario.path === 'nonempty') await mkdir(target, { recursive: true })
  if (scenario.path === 'nonempty') await writeFile(join(target, 'owned.txt'), 'keep')
  if (scenario.frozenBase) {
    const item: IssueWorkflow = {
      key: `o-r-${number}`,
      url: `https://github.com/o/r/issues/${number}`,
      repoKey: 'o/r',
      worktree: target,
      branch: `repo-issue-${number}`,
      stage: 'idle',
      devAgent: null,
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: null,
      reviewTaskId: null,
      reviewSessionId: undefined as never,
      reviewSessionAgent: undefined as never,
      reviewResult: null,
      prNumber: undefined as never,
      issueState: undefined as never,
      baseRef: scenario.frozenBase,
      updatedAt: 0,
      events: undefined as never,
    }
    await saveWorkflow(item)
  }
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command === 'git fetch origin --prune')
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        if (spec.command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
          return scenario.symbolicRef === null
            ? { exitCode: 1, stdout: { text: '' }, stderr: { text: 'missing' } }
            : { exitCode: 0, stdout: { text: scenario.symbolicRef ?? 'origin/main' }, stderr: { text: '' } }
        }
        if (spec.command.includes('refs/remotes/origin/main') && spec.command.endsWith('; echo $?')) {
          return { exitCode: 0, stdout: { text: scenario.mainExists === false ? '1' : '0' }, stderr: { text: '' } }
        }
        if (spec.command.includes('refs/remotes/') && spec.command.endsWith('; echo $?')) {
          return { exitCode: 0, stdout: { text: scenario.remoteExists === false ? '1' : '0' }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('git rev-parse --short'))
          return { exitCode: 0, stdout: { text: scenario.baseHash ?? 'abc1234' }, stderr: { text: '' } }
        if (spec.command === 'git worktree list --porcelain') {
          const records =
            typeof scenario.records === 'function'
              ? scenario.records(target, `repo-issue-${number}`)
              : (scenario.records ?? '')
          return { exitCode: 0, stdout: { text: records }, stderr: { text: '' } }
        }
        if (spec.command.includes('refs/heads/') && spec.command.endsWith('; echo $?'))
          return { exitCode: 0, stdout: { text: scenario.branchExists ? '0' : '1' }, stderr: { text: '' } }
        if (scenario.failRemove && spec.command.startsWith('git worktree remove --force'))
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'stale record already gone' } }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
  }
  try {
    const result = await ensureWorktree(ctx as never, { owner: 'o', repo: 'r', number })
    const stored = await loadWorkflow(issueKey('o/r', number))
    return { result, commands, target, stored }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

test('worktree preparation fails clearly for missing config, repository, default ref and base hash', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-worktree-config-'))
  process.env.HOME = home
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await writeFile(join(home, '.clickvibe', 'config.yaml'), 'repos: {}\n')
    const noRepo = await ensureWorktree({} as never, { owner: 'o', repo: 'r', number: '1' })
    assert.equal(noRepo.ok, false)
    if (!noRepo.ok) assert.match(noRepo.error, /未配置仓库/)

    await writeFile(join(home, '.clickvibe', 'config.yaml'), 'repos:\n  o/r: /definitely/missing/clickvibe\n')
    const missingPath = await ensureWorktree({} as never, { owner: 'o', repo: 'r', number: '2' })
    assert.equal(missingPath.ok, false)
    if (!missingPath.ok) assert.match(missingPath.error, /仓库路径不存在/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
  const noDefault = await runScenario('3', { symbolicRef: null, mainExists: false })
  assert.equal(noDefault.result.ok, false)
  if (!noDefault.result.ok) assert.match(noDefault.result.error, /无法确定 origin 默认分支/)
  const noHash = await runScenario('4', { baseHash: '' })
  assert.equal(noHash.result.ok, false)
  if (!noHash.result.ok) assert.match(noHash.result.error, /无法读取开发基线提交/)
})

test('worktree preparation executes reuse, detached attach and existing-branch attach recoveries', async () => {
  const reuse = await runScenario('10', {
    path: 'nonempty',
    branchExists: true,
    records: (target, branch) => `worktree ${target}\nHEAD abc\nbranch refs/heads/${branch}\n\n`,
  })
  assert.equal(reuse.result.ok, true)
  assert.equal(
    reuse.commands.some((command) => command.startsWith('git worktree add')),
    false,
  )

  for (const [number, branchExists, expected] of [
    ['11', false, 'git switch -c'],
    ['12', true, 'git switch'],
  ] as const) {
    const rootProbe = await runScenario(number, {
      path: 'nonempty',
      branchExists,
      records: (target) => `worktree ${target}\nHEAD abc\ndetached\n\n`,
    })
    assert.equal(rootProbe.result.ok, true)
    assert.equal(
      rootProbe.commands.some((command) => command.startsWith(expected)),
      true,
    )
  }

  const conflict = await runScenario('13', { path: 'nonempty', branchExists: true })
  assert.equal(conflict.result.ok, false)
  if (!conflict.result.ok) assert.match(conflict.result.error, /未注册的非空目录/)
  assert.equal(conflict.stored, null)
})

test('stale registrations repair safely and deleted frozen bases cannot recreate a missing branch', async () => {
  // A frozen workflow skips first-selection persistence and exercises deleted
  // remote behavior independently from initial baseline validation.
  const deleted = await runScenario('20', {
    frozenBase: 'origin/release/deleted @ abc1234',
    remoteExists: false,
    branchExists: false,
    records: (target, branch) => `worktree ${target}\nHEAD abc\nbranch refs/heads/${branch}\n\n`,
  })
  assert.equal(deleted.result.ok, false)
  if (!deleted.result.ok) assert.match(deleted.result.error, /基线分支已不存在/)

  const existing = await runScenario('21', {
    frozenBase: 'origin/release/deleted @ abc1234',
    remoteExists: false,
    branchExists: true,
    failRemove: true,
    path: 'empty',
    records: (target, branch) => `worktree ${target}\nHEAD abc\nbranch refs/heads/${branch}\n\n`,
  })
  assert.equal(existing.result.ok, true)
  assert.equal(
    existing.commands.some((command) => command.startsWith('git worktree remove --force')),
    true,
  )
  assert.equal(
    existing.commands.some((command) => command.startsWith('git worktree add')),
    true,
  )
})
