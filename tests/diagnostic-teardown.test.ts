/**
 * Deterministic teardown interactions (issue #131 slice A, reviews 8-9):
 * a root-scoped drain must reach a fixed point over every stream under the
 * temp HOME — including streams registered while the drain is already
 * waiting — and all gating happens INSIDE the production queue via the
 * pending `maxBytes` promise (gates chained after the returned promise are
 * outside the queue and prove nothing).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appendDiagnosticLine,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  waitForAllDiagnosticLines,
} from '../src/infra/diagnostic-log-store.ts'
import { diagnosticLogPath } from '../src/infra/state-layout.ts'

const WORKFLOW_KEY = 'issue-YWktZGFtaW5nL2NsaWNrdmliZQ-77' // ai-daming/clickvibe#77

/** Gate INSIDE the production queue: the append's operation cannot start until the gate opens. */
function gatedAppend(root: string, workflowKey: unknown, line: string, gate: Promise<void>): Promise<void> {
  return appendDiagnosticLine(
    root,
    workflowKey,
    line,
    gate.then(() => DEFAULT_DIAGNOSTIC_MAX_BYTES),
  )
}

function assertNoLine(root: string, workflowKey: unknown, needle: string): void {
  const path = diagnosticLogPath(root, workflowKey)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  assert.ok(!text.includes(needle), `line "${needle}" must still be queued, not on disk`)
}

test('same-path trailing write stays inside the queue until the drain observes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-drain-trail-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    await appendDiagnosticLine(home, undefined, 'first', DEFAULT_DIAGNOSTIC_MAX_BYTES)

    let releaseMiddle!: () => void
    const middleGate = new Promise<void>((resolve) => {
      releaseMiddle = resolve
    })
    const middle = gatedAppend(home, undefined, 'middle', middleGate)

    let releaseTrailing!: () => void
    const trailingGate = new Promise<void>((resolve) => {
      releaseTrailing = resolve
    })
    // The trailing write queues behind the gated middle one — same path, so
    // it cannot touch disk before middle completes (production queue order).
    const trailing = gatedAppend(home, undefined, 'trailing', trailingGate)

    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, undefined, 'trailing')

    const drained = waitForAllDiagnosticLines(home)
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, undefined, 'trailing', 'still queued while the middle gate holds the stream')
    releaseMiddle()
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, undefined, 'trailing', 'still queued behind its own gate')
    releaseTrailing()
    await Promise.all([middle, trailing, drained])

    rmSync(home, { recursive: true, force: true })
    assert.equal(existsSync(home), false, 'no trailing resurrection after the drain')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('pre-existing workflow-scoped stream under the same root is drained', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-drain-scoped-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    await appendDiagnosticLine(home, undefined, 'global', DEFAULT_DIAGNOSTIC_MAX_BYTES)

    let releaseScoped!: () => void
    const scopedGate = new Promise<void>((resolve) => {
      releaseScoped = resolve
    })
    const scopedPath = diagnosticLogPath(home, WORKFLOW_KEY)
    assert.ok(scopedPath.startsWith(join(home, '')), 'production shape: state root + workflowKey')
    const scoped = gatedAppend(home, WORKFLOW_KEY, 'scoped', scopedGate)
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, WORKFLOW_KEY, 'scoped')

    const drained = waitForAllDiagnosticLines(home)
    releaseScoped()
    await Promise.all([scoped, drained])

    assert.ok(readFileSync(scopedPath, 'utf8').includes('scoped'))
    rmSync(home, { recursive: true, force: true })
    assert.equal(existsSync(home), false)
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a scoped stream registered while the drain is waiting is observed (fixed point)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-drain-late-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    // 1. Global stream gated so the drain starts waiting on it.
    let releaseGlobal!: () => void
    const globalGate = new Promise<void>((resolve) => {
      releaseGlobal = resolve
    })
    const global = gatedAppend(home, undefined, 'global', globalGate)
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, undefined, 'global')

    // 2. Drain begins (entry snapshot would capture only the global path).
    const drained = waitForAllDiagnosticLines(home)
    await new Promise((resolve) => setImmediate(resolve))

    // 3. A workflow-scoped stream registers under the same root mid-drain.
    let releaseScoped!: () => void
    const scopedGate = new Promise<void>((resolve) => {
      releaseScoped = resolve
    })
    const scoped = gatedAppend(home, WORKFLOW_KEY, 'scoped', scopedGate)
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, WORKFLOW_KEY, 'scoped')

    // 4. Freeing global alone must NOT complete the drain: the late scoped
    // stream was not in any entry snapshot. If the drain returned here, the
    // teardown would delete the root while the scoped write is still queued.
    releaseGlobal()
    await global
    await new Promise((resolve) => setImmediate(resolve))
    assertNoLine(home, WORKFLOW_KEY, 'scoped', 'the scoped write is still queued')

    let drainSettled = false
    void drained.then(() => {
      drainSettled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drainSettled, false, 'the drain must keep waiting for the late-registered stream')

    // 5. Release the scoped write: now the drain reaches its fixed point.
    releaseScoped()
    await Promise.all([scoped, drained])
    assert.ok(readFileSync(diagnosticLogPath(home, WORKFLOW_KEY), 'utf8').includes('scoped'))

    rmSync(home, { recursive: true, force: true })
    assert.equal(existsSync(home), false, 'no resurrection by the late scoped write')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
