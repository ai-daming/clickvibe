import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import { syncWorktree } from '../src/workflow/sync.ts'

test('sync rejects malformed targets and issues without a worktree before git access', async () => {
  const invalid = await syncWorktree({} as never, undefined)
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.error, /请输入形如/)

  const pull = await syncWorktree({} as never, { url: 'https://github.com/o/r/pull/1' })
  assert.equal(pull.ok, false)
  if (!pull.ok) assert.match(pull.error, /请输入形如/)

  const missing = await syncWorktree({} as never, { url: 'https://github.com/o/r/issues/999999' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /尚无 worktree/)
})

test('concurrent sync requests serialize one workflow baseline-tip update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-lock-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-9',
      url: 'https://github.com/o/r/issues/9',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-9',
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
      baseRef: 'origin/main @ aaa0000',
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await saveWorkflow(workflow)
    let active = 0
    let maxActive = 0
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          if (spec.command.includes('MERGE_HEAD')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          const stdout = spec.command.includes('origin/main^{commit}')
            ? 'aaa1111'
            : spec.command === 'git rev-parse --short HEAD'
              ? 'bbb2222'
              : ''
          return { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }
        },
      },
    }
    const results = await Promise.all([
      syncWorktree(ctx as never, { url: workflow.url }),
      syncWorktree(ctx as never, { url: workflow.url }),
    ])
    assert.equal(
      results.every((result) => result.ok),
      true,
    )
    assert.equal(maxActive, 1)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
