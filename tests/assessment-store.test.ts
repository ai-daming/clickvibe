import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { recoveryHome } from './helpers/recovery-home.ts'
import { AssessmentStore } from '../src/infra/assessment-store.ts'
import { assessmentReport, assessmentView } from '../src/workflow/assessment-policy.ts'

const input = {
  url: 'https://github.com/o/r/issues/177',
  repoKey: 'o/r',
  repoPath: '/repo',
  title: 'Evaluate',
  body: '## 目标\nA',
  basis: 'basis-a',
  baseOid: 'a'.repeat(40),
  model: { provider: 'test', model: 'test' },
}

test('assessment admission deduplicates and persists results independently of comment publication', async () => {
  const { home } = await recoveryHome([])
  const root = `${home}/.clickvibe/state-recovery-1`
  try {
    const store = new AssessmentStore(root)
    const [a, b] = await Promise.all([store.submit([input]), store.submit([input])])
    assert.equal(a[0].id, b[0].id)
    const run = await store.claim()
    assert.ok(run)
    assert.equal(await store.claim(), null)
    const report = assessmentReport('Implementation Gate: NEEDS_DECISION\nWork: o/r#177\n需要确认导出格式。')
    await store.complete(run, report)
    const restored = new AssessmentStore(root)
    const runs = await restored.list()
    assert.equal(runs[0].phase, 'completed')
    assert.equal(runs[0].publication.status, 'pending')
    assert.deepEqual(await restored.report(runs[0]), report)
    assert.equal((await restored.submit([input]))[0].id, run.id)
    assert.equal(assessmentView(runs[0], input.basis).discussion, true)
    assert.equal(assessmentView(runs[0], 'new-basis').discussion, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('old callbacks cannot settle cancelled runs or replace newer basis', async () => {
  const { home } = await recoveryHome([])
  try {
    const store = new AssessmentStore(`${home}/.clickvibe/state-recovery-1`)
    await store.submit([input])
    const old = await store.claim()
    assert.ok(old)
    await store.cancel(old.id)
    await assert.rejects(
      store.complete(old, assessmentReport('Implementation Gate: READY\nWork: o/r#177\n可以实现。')),
      /cancel|owner|运行/,
    )
    const newer = await store.submit([{ ...input, basis: 'basis-b' }])
    assert.notEqual(newer[0].id, old.id)
    assert.equal((await store.list()).find((x) => x.id === old.id)?.phase, 'cancelled')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('unassessed, failure, stale and evidence gaps do not manufacture a discussion recommendation', () => {
  assert.equal(assessmentView(undefined, 'basis').discussion, false)
  assert.throws(() => assessmentReport('READY'), /结论|报告/)
  assert.throws(() => assessmentReport('Implementation Gate: READY\nImplementation Gate: NEEDS_DECISION'), /结论|报告/)
})

test('controller errors survive restart without replacing reports or workflow facts', async () => {
  const { home } = await recoveryHome([])
  try {
    const root = `${home}/.clickvibe/state-recovery-1`
    await new AssessmentStore(root).rememberError('Host session unavailable')
    assert.equal((await new AssessmentStore(root).read()).error, 'Host session unavailable')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('unsupported stored versions are preserved rather than overwritten by new admission', async () => {
  const { home } = await recoveryHome([])
  try {
    const root = `${home}/.clickvibe/state-recovery-1`
    const store = new AssessmentStore(root)
    await store.submit([input])
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = `${root}/assessments/state.json`
    const unsupported = JSON.stringify({ ...(await store.read()), schema: 99 })
    await writeFile(path, unsupported)
    await assert.rejects(store.submit([input]), /格式不可用/)
    assert.equal(await readFile(path, 'utf8'), unsupported)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a stale owner cannot publish a report and corrupt report bytes cannot be reused', async () => {
  const { home } = await recoveryHome([])
  try {
    const root = `${home}/.clickvibe/state-recovery-1`
    const store = new AssessmentStore(root)
    await store.submit([input])
    const claimed = await store.claim()
    assert.ok(claimed?.owner)
    const report = assessmentReport('Implementation Gate: READY\nWork: o/r#177\n说明')
    await assert.rejects(store.complete({ ...claimed, owner: { ...claimed.owner, token: 'stale' } }, report), /owner/)
    assert.equal((await store.list())[0].phase, 'running')
    await store.complete(claimed, report)
    const saved = (await store.list())[0]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${root}/assessments/${saved.id}-${saved.reportHash}.json`, '{}')
    await assert.rejects(store.report(saved), /完整性/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
