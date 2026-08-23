import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { issueKey, saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import { restoreBaseBranch } from '../src/workflow/baseline-restore.ts'

const execFileAsync = promisify(execFile)

function realShellCtx() {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8' })
          return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
        } catch (error) {
          const detail = error as { code?: number; stdout?: string; stderr?: string }
          return {
            exitCode: detail.code ?? 1,
            stdout: { text: detail.stdout ?? '' },
            stderr: { text: detail.stderr ?? '' },
          }
        }
      },
    },
  }
}

test('authorized recovery recreates only the frozen missing base branch at its frozen commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-base-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'main base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'release/deleted')
    await git('commit', '--allow-empty', '-m', 'release base')
    const frozen = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', '-u', 'origin', 'release/deleted')
    await git('push', 'origin', '--delete', 'release/deleted')
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    await saveWorkflow({
      key: issueKey('o/r', '60'),
      url: 'https://github.com/o/r/issues/60',
      repoKey: 'o/r',
      worktree: join(root, 'worktrees', 'repo', 'repo-issue-60'),
      branch: 'repo-issue-60',
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
      baseRef: `origin/release/deleted @ ${frozen}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow)

    const restored = await restoreBaseBranch(realShellCtx() as never, { url: 'https://github.com/o/r/issues/60' })
    assert.deepEqual(restored, { ok: true, baseBranch: 'release/deleted', baseHash: frozen })
    const remoteHash = (
      await execFileAsync('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/heads/release/deleted'])
    ).stdout.trim()
    assert.equal(remoteHash, frozen)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
