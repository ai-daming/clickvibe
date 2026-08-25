import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { enrichWorkflowStates } from '../src/workflow/repository-state.ts'

const execFileAsync = promisify(execFile)

function workflow(worktree: string, key: string): IssueWorkflow {
  return {
    key,
    url: 'https://github.com/o/r/issues/122',
    repoKey: 'o/r',
    worktree,
    branch: 'clickvibe-issue-122',
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
    baseRef: null,
    updatedAt: Date.now(),
    events: [],
  }
}

test('refreshing N workflows uses one host subprocess per live worktree for git facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-git-facts-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'issue')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  try {
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('worktree', 'add', '-b', 'clickvibe-issue-122', worktree, 'origin/main')
    await wt('commit', '--allow-empty', '-m', 'dev work C')
    await wt('push', '-u', 'origin', 'clickvibe-issue-122')
    const upstreamHead = (await wt('rev-parse', '--short', 'HEAD')).stdout.trim()
    await wt('commit', '--allow-empty', '-m', 'dev work D')
    await writeFile(join(worktree, 'dirty.txt'), 'uncommitted work\n')

    const commands: string[] = []
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string; workdir?: string }) {
          if (spec.command.startsWith('gh api ')) {
            const body = spec.command.includes('/issues/122')
              ? { number: 122, state: 'open', body: '', updated_at: '2026-08-25T00:00:00Z' }
              : []
            return {
              exitCode: 0,
              stdout: { text: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}` },
              stderr: { text: '' },
            }
          }
          commands.push(spec.command)
          try {
            const result = await execFileAsync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir })
            return { exitCode: 0, stdout: { text: result.stdout }, stderr: { text: result.stderr } }
          } catch (error) {
            const result = error as { code?: number; stdout?: string; stderr?: string }
            return {
              exitCode: result.code ?? 1,
              stdout: { text: result.stdout ?? '' },
              stderr: { text: result.stderr ?? '' },
            }
          }
        },
      },
    }
    const workflowCount = 5
    const states = await enrichWorkflowStates(
      ctx as never,
      Array.from({ length: workflowCount }, (_, index) => workflow(worktree, `repo-${index}`)),
      { repos: { 'o/r': repo }, worktreeRoot: root } as never,
    )
    const derived = states[0].derived

    assert.equal(commands.length, workflowCount)
    assert.ok(commands.every((command) => command.includes('git status --porcelain=v2 --branch')))
    assert.ok(commands.every((command) => command.includes('git for-each-ref')))
    assert.equal(derived.branch, 'clickvibe-issue-122')
    assert.equal(derived.aheadOfBase, 2)
    assert.equal(derived.upstreamHead, upstreamHead)
    assert.equal(derived.behindUpstream, 0)
    assert.equal(derived.aheadOfUpstream, 1)
    assert.equal(derived.hasUncommittedChanges, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
