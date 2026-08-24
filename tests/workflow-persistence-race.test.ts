import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { type IssueWorkflow, loadWorkflow, saveWorkflowStrict, statePath } from '../src/infra/state.ts'

const workerSource = `
import { createInterface } from 'node:readline'
import { saveWorkflowForTask, saveWorkflowStrict } from './src/infra/state.ts'
console.log('ready')
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line)
  const saved = input.credential
    ? await saveWorkflowForTask(input.workflow, input.credential)
    : (await saveWorkflowStrict(input.workflow), true)
  console.log(JSON.stringify({ saved }))
}
`

async function startWorker(home: string) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', workerSource], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
  })
  const responses: Array<(saved: boolean) => void> = []
  const output = createInterface({ input: child.stdout })
  await once(output, 'line')
  output.on('line', (line) => {
    responses.shift()?.(Boolean((JSON.parse(line) as { saved: boolean }).saved))
  })
  return {
    process: child,
    run: (workflow: IssueWorkflow, credential?: { kind: 'review'; taskId: string }) =>
      new Promise<boolean>((resolve) => {
        responses.push(resolve)
        child.stdin.write(`${JSON.stringify({ workflow, credential })}\n`)
      }),
  }
}

function workflow(taskId: string, marker: string): IssueWorkflow {
  return {
    key: 'owner/repo/issue-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    stage: 'reviewing',
    devTaskId: 'dev-1000-previous',
    reviewTaskId: taskId,
    updatedAt: 0,
    events: [{ kind: 'note', at: marker, note: marker.repeat(64 * 1024) }],
  } as IssueWorkflow
}

test('task credential and commit are indivisible across host processes', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const staleWorker = await startWorker(tempHome)
  const successorWorker = await startWorker(tempHome)
  try {
    for (let round = 0; round < 100; round += 1) {
      const oldTaskId = `review-${1000 + round}-old`
      const nextTaskId = `review-${9000 + round}-current`
      const initial = workflow(oldTaskId, 'initial')
      await saveWorkflowStrict(initial)
      const stale = structuredClone(initial)
      stale.stage = 'review-ready'
      stale.events[0].note = 'stale'.repeat(64 * 1024)
      const staleWrite = staleWorker.run(stale, { kind: 'review', taskId: oldTaskId })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.all([staleWrite, successorWorker.run(workflow(nextTaskId, 'successor'))])

      const raw = await readFile(statePath(initial), 'utf8')
      assert.doesNotThrow(() => JSON.parse(raw), `round ${round} exposed partial workflow JSON`)
      const persisted = await loadWorkflow(initial.key)
      assert.equal(persisted?.reviewTaskId, nextTaskId, `round ${round} let the stale host overwrite its successor`)
      assert.equal(persisted?.stage, 'reviewing')
    }
    const recovered = workflow('review-9999-recovered', 'recovered')
    await writeFile(`${statePath(recovered)}.lock`, JSON.stringify({ pid: 2_147_483_647, token: 'dead-host' }))
    await saveWorkflowStrict(recovered)
    assert.equal((await loadWorkflow(recovered.key))?.reviewTaskId, recovered.reviewTaskId)
  } finally {
    staleWorker.process.stdin.end()
    successorWorker.process.stdin.end()
    await Promise.all([once(staleWorker.process, 'exit'), once(successorWorker.process, 'exit')])
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
