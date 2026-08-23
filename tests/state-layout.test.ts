import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeLiveLogEvent } from '../src/infra/live-output.ts'
import {
  appendTaskLog,
  loadWorkflow,
  readTaskLog,
  saveWorkflow,
  startTaskLog,
  type IssueWorkflow,
} from '../src/infra/state.ts'
import { issueDirectory, issueKey, parseIssueDirectory, taskLogPath, workflowPath } from '../src/infra/state-layout.ts'

function fixture(key = issueKey('a-b/c', '7')): IssueWorkflow {
  return {
    key,
    url: 'https://github.com/a-b/c/issues/7',
    repoKey: 'a-b/c',
    worktree: '/tmp/c-issue-7',
    branch: 'c-issue-7',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-1720000000000-first',
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
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
}

test('project issue paths are reversible and do not depend on collision-prone keys', () => {
  const root = '/state'
  assert.equal(issueDirectory(root, 'a-b', 'c', '7'), '/state/a-b/c/issue-7')
  assert.deepEqual(parseIssueDirectory(root, '/state/a-b/c/issue-7'), {
    owner: 'a-b',
    repo: 'c',
    issue: '7',
  })
  assert.equal(parseIssueDirectory(root, '/state/a-b/c/not-an-issue'), null)
  assert.throws(() => issueDirectory(root, '..', 'c', '7'), /invalid issue coordinates/)
  assert.throws(() => issueDirectory(root, 'a-b', '..', '7'), /invalid issue coordinates/)
  assert.notEqual(issueKey('a-b/c', '7'), issueKey('a/b-c', '7'))
  assert.equal(workflowPath(root, fixture()), '/state/a-b/c/issue-7/workflow.json')
})

test('task generations append valid structured JSONL independently and aggregate metrics', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-jsonl-'))
  process.env.HOME = tempHome
  try {
    const workflow = fixture()
    await saveWorkflow(workflow)
    const first = workflow.devTaskId!
    const second = 'dev-1720000005000-second'
    await startTaskLog(workflow, 'dev', first)
    await appendTaskLog(workflow, 'dev', first, 1, encodeLiveLogEvent({ source: 'agent', kind: 'text', text: 'one' }), {
      ts: '2026-08-23T00:00:00.000Z',
    })
    await appendTaskLog(workflow, 'dev', first, 2, '[clickvibe] complete', {
      ts: '2026-08-23T00:00:03.250Z',
      status: 'done',
      exitCode: 0,
    })
    await startTaskLog(workflow, 'dev', second)
    await appendTaskLog(workflow, 'dev', second, 1, 'two', { ts: '2026-08-23T00:00:05.000Z' })

    const firstRead = await readTaskLog(workflow, 'dev', first)
    const secondRead = await readTaskLog(workflow, 'dev', second)
    assert.deepEqual(firstRead.lines, ['one', '[clickvibe] complete'])
    assert.deepEqual(secondRead.lines, ['two'])
    assert.deepEqual(firstRead.metrics, {
      startedAt: '2026-08-23T00:00:00.000Z',
      endedAt: '2026-08-23T00:00:03.250Z',
      durationMs: 3250,
      status: 'done',
      exitCode: 0,
    })

    const raw = await readFile(taskLogPath(join(tempHome, '.clickvibe', 'state'), workflow, 'dev', first), 'utf8')
    const records = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(records[0].sequence, 1)
    assert.equal(records[0].source, 'agent')
    assert.equal(records[1].source, 'clickvibe')
    assert.ok(records.every((record) => record.taskId === first && typeof record.line === 'string'))
    await appendFile(taskLogPath(join(tempHome, '.clickvibe', 'state'), workflow, 'dev', first), '{"partial":', 'utf8')
    assert.deepEqual((await readTaskLog(workflow, 'dev', first)).lines, ['one', '[clickvibe] complete'])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('legacy flat workflow and logs migrate into the project tree without losing lines', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-migrate-'))
  process.env.HOME = tempHome
  try {
    const root = join(tempHome, '.clickvibe', 'state')
    const workflow = fixture('a-b-c-7')
    await mkdir(join(root, workflow.key), { recursive: true })
    await writeFile(join(root, `${workflow.key}.json`), JSON.stringify(workflow), 'utf8')
    await writeFile(join(root, workflow.key, 'dev.log'), 'first\n[clickvibe] second\n', 'utf8')

    const loaded = await loadWorkflow(workflow.key)
    assert.equal(loaded?.repoKey, 'a-b/c')
    const migrated = await readTaskLog(workflow, 'dev', workflow.devTaskId!)
    assert.deepEqual(migrated.lines, ['first', '[clickvibe] second'])
    assert.equal(await readFile(workflowPath(root, workflow), 'utf8').then(() => true), true)
    assert.equal(
      (await readdir(root)).some((entry) => entry === `${workflow.key}.json` || entry === workflow.key),
      false,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a failed legacy migration does not block reads and retries after the source is repaired', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-migrate-retry-'))
  process.env.HOME = tempHome
  try {
    const root = join(tempHome, '.clickvibe', 'state')
    const workflow = fixture('legacy-retry-7')
    const legacyPath = join(root, `${workflow.key}.json`)
    await mkdir(root, { recursive: true })
    await writeFile(legacyPath, '{broken', 'utf8')
    assert.equal(await loadWorkflow(workflow.key), null)
    await writeFile(legacyPath, JSON.stringify(workflow), 'utf8')
    assert.equal((await loadWorkflow(workflow.key))?.repoKey, workflow.repoKey)
    assert.equal(await readFile(workflowPath(root, workflow), 'utf8').then(() => true), true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
