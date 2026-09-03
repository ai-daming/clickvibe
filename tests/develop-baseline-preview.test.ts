import assert from 'node:assert/strict'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GithubRateLimitError } from '../src/github/rest.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { developBaselinePreview } from '../src/workflow/develop-baseline-preview.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

function workflow(number: string, baseRef: string): IssueWorkflow {
  return {
    key: `o-r-${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    repoKey: 'o/r',
    worktree: `/tmp/worktree-${number}`,
    branch: `repo-issue-${number}`,
    stage: 'idle',
    devAgent: null,
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
    baseRef,
    updatedAt: 0,
    events: [],
  }
}

test('baseline preview validates URLs and degrades an unconfigured repository only for the default', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-unconfigured-'))
  process.env.HOME = home
  try {
    await assert.rejects(developBaselinePreview({} as never, 'not github', undefined), /GitHub Issue URL/)
    const preview = await developBaselinePreview({} as never, 'https://github.com/o/r/issues/1', undefined)
    assert.equal(preview.baseline, 'origin/HEAD')
    assert.match(preview.baselineWarning ?? '', /未配置或不存在/)
    await assert.rejects(
      developBaselinePreview({} as never, 'https://github.com/o/r/issues/1', 'origin/release'),
      /无法在未配置的本地仓库中验证/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('baseline preview exposes fetch failure for the default but rejects an unverifiable custom ref', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-fetch-failure-'))
  process.env.HOME = home
  try {
    const repo = join(home, 'repo')
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await initFixtureRepository(repo)
    await activateV02Home(home, { 'o/r': repo })
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run() {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline' } }
        },
      },
    }
    const preview = await developBaselinePreview(ctx as never, 'https://github.com/o/r/issues/2', undefined)
    assert.match(preview.baselineWarning ?? '', /远端分支刷新失败.*offline/)
    await assert.rejects(
      developBaselinePreview(ctx as never, 'https://github.com/o/r/issues/2', 'origin/release'),
      /offline/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('baseline preview excludes and rejects the current issue development branch', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-self-'))
  process.env.HOME = home
  try {
    const repo = join(home, 'repo')
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await initFixtureRepository(repo)
    await activateV02Home(home, { 'o/r': repo })
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          const stdout = spec.command.startsWith('git symbolic-ref')
            ? 'origin/main'
            : spec.command.startsWith('git for-each-ref')
              ? 'origin/main\norigin/release/2.0\norigin/repo-issue-60'
              : ''
          return { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }
        },
      },
    }
    const preview = await developBaselinePreview(ctx as never, 'https://github.com/o/r/issues/60', undefined)
    assert.deepEqual(preview.baselineOptions, ['origin/HEAD', 'origin/main', 'origin/release/2.0'])
    await assert.rejects(
      developBaselinePreview(ctx as never, 'https://github.com/o/r/issues/60', 'origin/repo-issue-60'),
      /不能选择当前 Issue 开发分支/,
    )
    const selfDefaultCtx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          const stdout = spec.command.startsWith('git symbolic-ref')
            ? 'origin/repo-issue-60'
            : spec.command.startsWith('git for-each-ref')
              ? 'origin/repo-issue-60'
              : ''
          return { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }
        },
      },
    }
    await assert.rejects(
      developBaselinePreview(selfDefaultCtx as never, 'https://github.com/o/r/issues/60', undefined),
      /默认分支指向当前 Issue 开发分支/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('frozen issue-branch preview skips self-dependencies and ignores a closed parent issue', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-dependency-'))
  process.env.HOME = home
  try {
    await saveWorkflow(workflow('5', 'origin/clickvibe-issue-5 @ abc123'))
    const self = await developBaselinePreview({} as never, workflow('5', '').url, undefined)
    assert.equal(self.baselineDependencyIssue, null)

    await saveWorkflow(workflow('6', 'origin/clickvibe-issue-5 @ abc123'))
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run() {
          const issue = { number: 5, title: 'parent', state: 'closed', html_url: 'https://github.com/o/r/issues/5' }
          return {
            exitCode: 0,
            stdout: { text: ['HTTP/2.0 200 OK', '', JSON.stringify(issue)].join('\n') },
            stderr: { text: '' },
          }
        },
      },
    }
    const closed = await developBaselinePreview(ctx as never, workflow('6', '').url, undefined)
    assert.equal(closed.baselineDependencyIssue, null)

    await saveWorkflow(workflow('7', 'origin/clickvibe-issue-5 @ abc123'))
    // Phase 3 simulates a rate-limited fresh read; reset so the process owner
    // does not serve phase 2's cached issue detail across the ctx switch.
    resetGithubGatewayOwnerForTests()
    const rateLimited = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run() {
          throw new GithubRateLimitError(Date.now() + 60_000)
        },
      },
    }
    const warning = await developBaselinePreview(rateLimited as never, workflow('7', '').url, undefined)
    assert.match(warning.baselineWarning ?? '', /无法确认基线关联 Issue #5.*GitHub 额度已用完/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
