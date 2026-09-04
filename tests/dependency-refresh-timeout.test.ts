/**
 * Dependency-refresh timeout contract (#137 field report, 2026-09-04): a cold
 * dependency refresh walks several GitHub pages behind the gateway's paced
 * lane and measures ~7s on the operator machine. The client abort that used
 * to fire at 4s cut off refreshes the server still completed, showing a
 * recurring stale-dependency warning while the data arrived moments later.
 * The shared timeout must stay at or above the measured cold refresh.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DEPENDENCY_REFRESH_TIMEOUT_MS } from '../src/client/runtime.ts'

test('dependency refreshes keep a timeout at or above the measured cold refresh', async () => {
  assert.ok(DEPENDENCY_REFRESH_TIMEOUT_MS >= 15_000, `saw ${DEPENDENCY_REFRESH_TIMEOUT_MS}ms`)

  const source = await readFile(join(process.cwd(), 'src', 'client', 'project-state.ts'), 'utf8')
  assert.equal(
    source.includes('DEPENDENCY_REFRESH_TIMEOUT_MS)'),
    true,
    'both refresh calls must use the shared timeout',
  )
  assert.equal(source.includes(', 4_000)'), false, 'no bare 4s abort may return to the refresh calls')
})
