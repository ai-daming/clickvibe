/**
 * AC3 final boundary: the runtime has no v0.1 config reader. A config.yaml
 * without schemaVersion is rejected with a pointer to the offline upgrade
 * entry (ADR-0009 D1, ADR-0013 §6a, issue #137). The schema-1 path and the
 * fresh-install ENOENT default are covered by the v02-upgrade-apply suite.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfigFromHome } from '../src/infra/runtime.ts'

test('a v0.1 repos config is rejected with the upgrade entry pointer', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-no-legacy-config-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.clickvibe'), { recursive: true })
  await writeFile(
    join(home, '.clickvibe', 'config.yaml'),
    `repos:\n  o/r: ${join(home, 'repo')}\nfetchTtlSeconds: 45\n`,
  )

  await assert.rejects(loadConfigFromHome(home), /v0\.1 config is no longer readable.*scripts\/upgrade-v0\.2\.mjs/s)
})

test('a fresh install without config.yaml still selects the documented defaults', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-fresh-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const config = await loadConfigFromHome(home)
  assert.deepEqual(config.repos, {})
  assert.equal(config.worktreeRoot, join(home, '.clickvibe', 'worktrees'))
})
