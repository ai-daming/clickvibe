import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { activateV02Home, initFixtureRepository } from './helpers/v02-home.ts'
import { issueKey } from '../src/infra/state-layout.ts'
import { logTaskDiagnostic } from '../src/infra/task-diagnostics.ts'

async function readEventually(path: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

test('task diagnostics persist the exact console JSON under the owning issue', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostics-'))
  const previousHome = process.env.HOME
  const originalWarn = console.warn
  const warnings: string[] = []
  process.env.HOME = tempHome
  console.warn = (message?: unknown) => warnings.push(String(message))
  try {
    const errorStack = 'Error: forced reconcile failure\n    at reconcileOnce (auto-run.ts:1:1)'
    logTaskDiagnostic('auto-run-reconcile-error', {
      workflowKey: issueKey('owner/repo', '123'),
      errorName: 'Error',
      errorMessage: 'forced reconcile failure',
      errorStack,
    })

    const path = join(tempHome, '.clickvibe', 'state', 'owner', 'repo', 'issue-123', 'diagnostics.jsonl')
    const raw = await readEventually(path)
    assert.equal(raw, `${warnings[0]}\n`)
    const persisted = JSON.parse(raw)
    assert.equal(persisted.workflowKey, issueKey('owner/repo', '123'))
    assert.equal(persisted.errorName, 'Error')
    assert.equal(persisted.errorMessage, 'forced reconcile failure')
    assert.equal(persisted.errorStack, errorStack)
    await assert.rejects(readFile(join(tempHome, '.clickvibe', 'state', 'diagnostics.jsonl'), 'utf8'), /ENOENT/)
  } finally {
    console.warn = originalWarn
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('an oversized diagnostic remains complete when the next record rotates it', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostics-rotation-'))
  const previousHome = process.env.HOME
  const originalWarn = console.warn
  const warnings: string[] = []
  process.env.HOME = tempHome
  console.warn = (message?: unknown) => warnings.push(String(message))
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    const diagRepo = await initFixtureRepository(join(tempHome, 'diag-repo'))
    await activateV02Home(tempHome, { 'o/r': diagRepo }, { diagnosticsMaxBytes: 200 })
    logTaskDiagnostic('global-oversized', { workflowKey: issueKey('foo', '7'), evidence: 'a'.repeat(1_000) })
    logTaskDiagnostic('global-next', { evidence: 'next' })

    const path = join(tempHome, '.clickvibe', 'state', 'diagnostics.jsonl')
    const rotatedPath = join(tempHome, '.clickvibe', 'state', 'diagnostics.1.jsonl')
    const rotated = await readEventually(rotatedPath)
    const active = await readEventually(path)
    assert.equal(rotated, `${warnings[0]}\n`)
    assert.equal(active, `${warnings[1]}\n`)
    assert.equal(JSON.parse(rotated).evidence, 'a'.repeat(1_000))
    assert.equal(JSON.parse(active).evidence, 'next')
  } finally {
    console.warn = originalWarn
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('diagnostic persistence failure never escapes logTaskDiagnostic', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-diagnostics-failure-'))
  const previousHome = process.env.HOME
  const originalWarn = console.warn
  process.env.HOME = tempHome
  console.warn = () => undefined
  try {
    await writeFile(join(tempHome, '.clickvibe'), 'blocks state directory creation', 'utf8')
    assert.doesNotThrow(() => logTaskDiagnostic('best-effort', { workflowKey: issueKey('owner/repo', '123') }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    console.warn = originalWarn
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
