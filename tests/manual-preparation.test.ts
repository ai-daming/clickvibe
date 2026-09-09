import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, realpath, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateRecoveryHome } from './helpers/recovery-home.ts'
import { git, initFixtureRepository } from './helpers/v02-home.ts'
import { autoRunWorkflowFixture, commitWorkflowFixture } from './workflow-fixture.ts'
import { workflowStatePath } from '../src/infra/workflow-persistence.ts'
import { claimWorkflowTaskCommand } from '../src/infra/workflow-persistence.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureWorktree } from '../src/agent/worktree.ts'
import { closeRemoteGitCoordinator } from '../src/infra/remote-git.ts'
import {
  previewManualPreparation,
  publishManualPreparation,
  readBootIdentity,
} from '../src/infra/manual-preparation.ts'

test('offline settlement preserves authority history, refuses drift and reads back publication idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-manual-'))
  const home = join(root, 'home'),
    repo = join(root, 'repo'),
    directory = join(root, 'plan')
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    await initFixtureRepository(repo)
    await activateRecoveryHome(home, { 'o/r': repo }, { worktreeRoot: join(root, 'worktrees') })
    const workflow = autoRunWorkflowFixture(home, '170')
    workflow.repoKey = 'o/r'
    const { issueKey } = await import('../src/infra/state.ts')
    workflow.key = issueKey('o/r', '170')
    workflow.url = 'https://github.com/o/r/issues/170'
    workflow.branch = 'repo-issue-170'
    workflow.worktree = join(root, 'worktrees', 'repo', workflow.branch)
    await git(repo, 'worktree', 'add', '-b', workflow.branch, workflow.worktree)
    const head = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'update-ref', 'refs/remotes/origin/main', head)
    await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    workflow.baseRef = `origin/main @ ${head}`
    workflow.preparation = {
      schema: 1,
      attemptId: 'original',
      runtimeInstanceId: 'previous-runtime',
      taskStateRevision: 0,
      worktree: await realpath(workflow.worktree),
      branch: workflow.branch,
      commonDir: await realpath(join(repo, '.git')),
      baseRef: 'origin/main',
      baseOid: head,
      expectedHead: head,
      status: 'dispatched',
    }
    await commitWorkflowFixture(workflow, null)
    const source = workflowStatePath(workflow)
    await chmod(source, 0o600)
    const original = await readFile(source, 'utf8')
    const evidence = join(root, 'evidence.json')
    const boot = await readBootIdentity()
    await writeFile(
      evidence,
      JSON.stringify({
        operator: 'fixture',
        reason: 'fixture verification, not a real reboot',
        beforeBoot: '0'.repeat(64),
        afterBoot: boot,
        allWritersStopped: true,
        restartDisabled: true,
        localStandardGitOnly: true,
        exclusiveWindow: true,
        backupComplete: true,
      }),
      { mode: 0o600 },
    )
    const invalidCases = [
      (w: typeof workflow) => {
        w.autoRun!.status = 'unknown' as 'paused'
      },
      (w: typeof workflow) => {
        w.preparation!.schema = 9 as 1
      },
      (w: typeof workflow) => {
        w.devTaskId = 'still-referenced'
      },
      (w: typeof workflow) => {
        w.prCreate = { status: 'pending', at: 'now' }
      },
      (w: typeof workflow) => {
        w.autoRun!.recoveryBudget = undefined
      },
      (w: typeof workflow) => {
        w.preparation!.status = 'verified'
      },
      (w: typeof workflow) => {
        w.repoKey = 'foreign/repo'
      },
      (w: typeof workflow) => {
        w.worktree = repo
      },
      (w: typeof workflow) => {
        w.preparation!.commonDir = root
      },
      (w: typeof workflow) => {
        w.preparation!.expectedHead = 'a'.repeat(40)
      },
      (w: typeof workflow) => {
        w.baseRef = 'origin/other @ wrong'
      },
    ]
    for (const change of invalidCases) {
      const invalid = JSON.parse(original)
      change(invalid)
      const bytes = JSON.stringify(invalid)
      await writeFile(source, bytes)
      await assert.rejects(previewManualPreparation({ home, key: workflow.key, evidence, directory }))
      assert.equal(await readFile(source, 'utf8'), bytes)
    }
    await writeFile(source, original)
    const fingerprint = await previewManualPreparation({ home, key: workflow.key, evidence, directory })
    const evidenceBytes = await readFile(evidence, 'utf8')
    const badEvidence = { ...JSON.parse(evidenceBytes), beforeBoot: boot }
    await writeFile(evidence, JSON.stringify(badEvidence))
    await assert.rejects(publishManualPreparation(directory, fingerprint, evidence), /evidence/)
    await writeFile(evidence, evidenceBytes)
    const targetFile = join(directory, 'target.json'),
      targetBytes = await readFile(targetFile, 'utf8')
    const tampered = JSON.parse(targetBytes)
    tampered.autoRun.recoveryBudget.cooldownUsed = true
    await writeFile(targetFile, JSON.stringify(tampered))
    await assert.rejects(publishManualPreparation(directory, fingerprint, evidence), /difference/)
    await writeFile(targetFile, targetBytes)
    await assert.rejects(publishManualPreparation(directory, 'wrong', evidence), /fingerprint/)
    await writeFile(join(workflow.worktree, 'dirty'), 'retain me')
    await assert.rejects(publishManualPreparation(directory, fingerprint, evidence), /dirty|scene/)
    assert.equal(await readFile(source, 'utf8'), original)
    await rm(join(workflow.worktree, 'dirty'))
    const gitDir = await git(workflow.worktree, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(gitDir, 'MERGE_HEAD'), head)
    await assert.rejects(publishManualPreparation(directory, fingerprint, evidence), /operation/)
    await rm(join(gitDir, 'MERGE_HEAD'))
    let writes = 0
    const exec = promisify(execFile)
    const context = {
      jobs: { list: () => [], get: () => undefined },
      shell: {
        resolve: (spec: unknown) => spec,
        run: async (spec: { command: string; workdir: string }) => {
          // Fixture remote refs are pinned locally; no network needed for the unrelated fetch adapter.
          if (/\bfetch\s/.test(spec.command)) return { exitCode: 0, stdout: { text: '' } }
          if (/worktree (add|remove)|git switch/.test(spec.command)) writes++
          try {
            const out = await exec('/bin/sh', ['-c', spec.command], { cwd: spec.workdir })
            return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
          } catch (error) {
            const e = error as { code: number; stdout?: string; stderr?: string }
            return { exitCode: e.code, stdout: { text: e.stdout ?? '' }, stderr: { text: e.stderr ?? '' } }
          }
        },
      },
    }
    const unknown = await ensureWorktree(context as never, { owner: 'o', repo: 'r', number: '170' })
    assert.equal(unknown.ok, false)
    assert.equal(JSON.parse(await readFile(source, 'utf8')).preparation.status, 'dispatched')
    assert.equal(writes, 0)
    const cli = await exec(process.execPath, [
      'scripts/manual-preparation.mjs',
      'publish',
      directory,
      fingerprint,
      evidence,
    ])
    assert.match(cli.stdout, /settled and paused/)
    const published = await readFile(source, 'utf8'),
      after = JSON.parse(published),
      before = JSON.parse(original)
    assert.equal(after.preparation.status, 'settled')
    assert.equal(after.preparation.attemptId, 'original')
    assert.equal(after.taskStateRevision, before.taskStateRevision + 1)
    assert.equal(after.preparation.taskStateRevision, after.taskStateRevision)
    assert.equal(after.devInterrupted, true)
    assert.equal(after.autoRun.status, 'paused')
    assert.deepEqual(after.autoRun.recoveryBudget, before.autoRun.recoveryBudget)
    assert.equal(after.events.length, before.events.length + 1)
    await publishManualPreparation(directory, fingerprint, evidence)
    assert.equal(await readFile(source, 'utf8'), published)
    await writeFile(source, `${published}\n`)
    await assert.rejects(publishManualPreparation(directory, fingerprint, evidence), /drift/)
    await writeFile(source, published)
    const stale = await claimWorkflowTaskCommand(
      after,
      { kind: 'dev', taskId: 'dev-old', agent: 'codex', hostJobId: 'old' },
      after.revision,
      { task: null, taskStateRevision: before.taskStateRevision },
    )
    assert.equal(stale.status, 'ownership-lost')
    const noGrant = await ensureWorktree(context as never, { owner: 'o', repo: 'r', number: '170' })
    assert.equal(noGrant.ok, false)
    const fresh = await ensureWorktree(
      context as never,
      { owner: 'o', repo: 'r', number: '170' },
      undefined,
      after.taskStateRevision,
    )
    assert.equal(fresh.ok, true, JSON.stringify(fresh))
    assert.equal(writes, 0)
    assert.equal(await git(workflow.worktree, 'rev-parse', 'HEAD'), head)
  } finally {
    await closeRemoteGitCoordinator()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
