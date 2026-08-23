import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GithubRateLimitError } from '../src/github/rest.ts'
import { saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import { developBaselinePreview } from '../src/workflow/develop-baseline-preview.ts'

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
    await rm(home, { recursive: true, force: true })
  }
})

test('baseline preview exposes fetch failure for the default but rejects an unverifiable custom ref', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-baseline-fetch-failure-'))
  process.env.HOME = home
  try {
    const repo = join(home, 'repo')
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(home, '.clickvibe', 'config.yaml'), ['repos:', `  o/r: ${repo}`, ''].join('\n'))
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
    await rm(home, { recursive: true, force: true })
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
    await rm(home, { recursive: true, force: true })
  }
})
