import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mergingWorkflows } from '../src/infra/runtime.ts'
import { saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import {
  authorizeAgent,
  mergeAndCleanup,
  mergeAndCleanupUnlocked,
  mergeAuthorizationPreview,
} from '../src/workflow/merge.ts'

function workflow(number: string, overrides: Partial<IssueWorkflow> = {}): IssueWorkflow {
  return {
    key: `o-r-${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    repoKey: 'o/r',
    worktree: `/tmp/worktrees/repo/repo-issue-${number}`,
    branch: `repo-issue-${number}`,
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
    prNumber: '7',
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc123',
    updatedAt: 0,
    events: [],
    ...overrides,
  }
}

function included(body: unknown): string {
  return ['HTTP/2.0 200 OK', '', JSON.stringify(body)].join('\n')
}

function prCtx(options: { state?: string; head?: string; base?: string; sha?: string; fail?: boolean } = {}) {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (options.fail) return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline' } }
        const body = spec.command.includes('/reviews')
          ? []
          : {
              number: 7,
              state: options.state ?? 'open',
              merged_at: null,
              html_url: 'https://github.com/o/r/pull/7',
              updated_at: 'now',
              head: { ref: options.head ?? 'repo-issue-1', sha: options.sha },
              base: { ref: options.base ?? 'main' },
            }
        return { exitCode: 0, stdout: { text: included(body) }, stderr: { text: '' } }
      },
    },
  }
}

test('merge authorization preview rejects invalid, missing, unreadable, closed and mismatched targets', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-merge-preview-'))
  process.env.HOME = home
  try {
    await assert.rejects(mergeAuthorizationPreview({} as never, 'not github'), /GitHub Issue URL/)
    await assert.rejects(mergeAuthorizationPreview({} as never, 'https://github.com/o/r/issues/1'), /未找到/)
    await saveWorkflow(workflow('1'))
    await assert.rejects(mergeAuthorizationPreview(prCtx({ fail: true }) as never, workflow('1').url), /无法读取/)
    await assert.rejects(mergeAuthorizationPreview(prCtx({ state: 'closed' }) as never, workflow('1').url), /PR 已关闭/)
    await assert.rejects(
      mergeAuthorizationPreview(prCtx({ head: 'other' }) as never, workflow('1').url),
      /分支与 workflow 不一致/,
    )

    const delivered = workflow('1', {
      delivery: {
        status: 'merged',
        mergedAt: 'now',
        prHead: 'frozen-head',
        mergeStrategy: 'merge',
        cleanup: { worktree: false, localBranch: false, remoteBranch: false, issue: false },
      },
    })
    await saveWorkflow(delivered)
    const preview = await mergeAuthorizationPreview(prCtx() as never, delivered.url)
    assert.equal(preview.ok, true)
    assert.equal(preview.head, 'frozen-head')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('merge execution validates URL, exclusivity, workflow, config, worktree root and branch before mutation', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-merge-validation-'))
  process.env.HOME = home
  try {
    assert.match((await mergeAndCleanup({} as never, undefined)).error, /GitHub Issue URL/)
    const key = 'o-r-2'
    mergingWorkflows.add(key)
    assert.match(
      (await mergeAndCleanup({} as never, { url: 'https://github.com/o/r/issues/2' })).error,
      /正在合并或清理/,
    )
    mergingWorkflows.delete(key)
    assert.match(
      (await mergeAndCleanupUnlocked({} as never, { url: 'https://github.com/o/r/pull/2' })).error,
      /GitHub Issue URL/,
    )
    assert.match(
      (await mergeAndCleanupUnlocked({} as never, { url: 'https://github.com/o/r/issues/2' })).error,
      /未找到可合并/,
    )

    await saveWorkflow(workflow('2'))
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await writeFile(join(home, '.clickvibe', 'config.yaml'), 'repos: {}\n')
    assert.match((await mergeAndCleanupUnlocked({} as never, { url: workflow('2').url })).error, /未配置项目/)

    const repo = join(home, 'repo')
    const root = join(home, 'worktrees')
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${root}`, ''].join('\n'),
    )
    await saveWorkflow(workflow('2', { worktree: join(home, 'outside') }))
    assert.match(
      (await mergeAndCleanupUnlocked({} as never, { url: workflow('2').url })).error,
      /不在已配置 worktreeRoot/,
    )
    await saveWorkflow(workflow('2', { worktree: join(root, 'repo', 'issue-2'), branch: ' ' }))
    assert.match((await mergeAndCleanupUnlocked({} as never, { url: workflow('2').url })).error, /分支无效/)
  } finally {
    mergingWorkflows.delete('o-r-2')
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('authorization wrapper turns malformed inputs and thrown non-Error values into readable failures', async () => {
  const invalid = await authorizeAgent({} as never, null)
  assert.equal(invalid.ok, false)
  const thrown = await authorizeAgent({} as never, { action: 'merge', url: 'not github' })
  assert.equal(thrown.ok, false)
  if (!thrown.ok) assert.match(thrown.error, /GitHub URL 无效/)
})
