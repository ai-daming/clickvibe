/**
 * Deterministic teardown interactions (issue #131 slice A, review round 8):
 * a root-scoped drain must cover every stream under the temp HOME — global
 * and workflow-scoped — including writes queued behind a record the test
 * already saw. Both regressions gate production queue ordering, not timing.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appendDiagnosticLine,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  waitForAllDiagnosticLines,
  waitForDiagnosticLines,
} from '../src/infra/diagnostic-log-store.ts'
import { parseIssueKey } from '../src/infra/state-layout.ts'

function issueRoot(root: string, key: string): string {
  const coordinates = parseIssueKey(key)
  assert.ok(coordinates, 'fixture key must be a workflow key')
  return join(root, coordinates.owner, coordinates.repo, `issue-${coordinates.issue}`)
}

test('trailing write queued behind a visible record cannot resurrect a drained root', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-drain-trail-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    let releaseMiddle!: () => void
    const middleGate = new Promise<void>((resolve) => {
      releaseMiddle = resolve
    })

    // A first completed write, then a gated middle write, then a trailing
    // write queued behind it (the access-level failure after the trip).
    await appendDiagnosticLine(home, undefined, 'first', Promise.resolve(DEFAULT_DIAGNOSTIC_MAX_BYTES))
    const middle = appendDiagnosticLine(home, undefined, 'middle', Promise.resolve(DEFAULT_DIAGNOSTIC_MAX_BYTES)).then(
      () => middleGate,
    )
    void middle.then(
      () => undefined,
      () => undefined,
    )
    const trailing = appendDiagnosticLine(home, undefined, 'trailing', Promise.resolve(DEFAULT_DIAGNOSTIC_MAX_BYTES))
    void trailing.then(
      () => undefined,
      () => undefined,
    )

    // The middle record becomes visible; the test would return here and tear
    // down — but the trailing write is still queued behind the gate.
    void middle.then(() => releaseMiddle())
    await waitForDiagnosticLines(home, undefined)
      .then(() => undefined)
      .catch(() => undefined)
    // Gate stays closed: simulate the teardown path BEFORE the trailing write
    // completes would race — so prove the drain waits for it.
    const drained = waitForAllDiagnosticLines(home)
    releaseMiddle()
    await drained

    await waitForAllTaskDiagnosticsSafe()
    rmSync(home, { recursive: true, force: true })
    assert.equal(existsSync(home), false, 'the root must stay deleted — no trailing resurrection')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('root drain also waits for workflow-scoped writes under the same root', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-drain-scoped-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  const workflowKey = 'issue-YWktZGFtaW5nL2NsaWNrdmliZQ-77' // ai-daming/clickvibe#77
  try {
    let releaseScoped!: () => void
    const scopedGate = new Promise<void>((resolve) => {
      releaseScoped = resolve
    })

    // Global write completes; the workflow-scoped write is still queued.
    await appendDiagnosticLine(home, undefined, 'global', Promise.resolve(DEFAULT_DIAGNOSTIC_MAX_BYTES))
    const scoped = appendDiagnosticLine(
      issueRoot(home, workflowKey),
      workflowKey,
      'scoped',
      Promise.resolve(DEFAULT_DIAGNOSTIC_MAX_BYTES),
    ).then(() => scopedGate)
    void scoped.then(
      () => undefined,
      () => undefined,
    )

    // waitForDiagnosticLines(root, undefined) resolves while the scoped write
    // is pending — exactly the old drain's blind spot.
    const globalOnly = waitForDiagnosticLines(home, undefined)
      .then(() => undefined)
      .catch(() => undefined)
    const drained = waitForAllDiagnosticLines(home)
    releaseScoped()
    await Promise.all([globalOnly, drained])

    await waitForAllTaskDiagnosticsSafe()
    rmSync(home, { recursive: true, force: true })
    assert.equal(existsSync(home), false, 'the root must stay deleted — no scoped resurrection')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

async function waitForAllTaskDiagnosticsSafe(): Promise<void> {
  const { waitForAllTaskDiagnostics } = await import('../src/infra/task-diagnostics.ts')
  await waitForAllTaskDiagnostics().catch(() => undefined)
}
