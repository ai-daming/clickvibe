import assert from 'node:assert/strict'
import test from 'node:test'
import { ExclusiveTaskGate } from '../src/infra/task-gate.ts'

interface TestTask {
  id: string
  closed: boolean
}

test('exclusive task gate synchronously reuses an active task for the same workflow', () => {
  const gate = new ExclusiveTaskGate<TestTask>()
  let creates = 0
  const create = (): TestTask => ({ id: `review-${++creates}`, closed: false })

  const first = gate.reserve('owner-repo-22', create)
  const concurrent = gate.reserve('owner-repo-22', create)

  assert.equal(first.created, true)
  assert.equal(concurrent.created, false)
  assert.equal(concurrent.task, first.task)
  assert.equal(creates, 1)
})

test('releasing an old task cannot remove its newer replacement', () => {
  const gate = new ExclusiveTaskGate<TestTask>()
  const old = gate.reserve('owner-repo-22', () => ({ id: 'old', closed: false })).task
  old.closed = true
  const current = gate.reserve('owner-repo-22', () => ({ id: 'current', closed: false })).task

  gate.release('owner-repo-22', old)
  const reused = gate.reserve('owner-repo-22', () => ({ id: 'unexpected', closed: false }))

  assert.equal(reused.created, false)
  assert.equal(reused.task, current)
})
