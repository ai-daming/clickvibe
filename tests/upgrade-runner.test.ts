/**
 * Offline upgrade runner tests (ADR-0013 §5, protocol §12, issue #137 AC2/AC3).
 *
 * The runner is spawned exactly like an operator runs it against a real git
 * fixture home: preview is zero-write and prints the plan JSON for the
 * operator to keep; apply/resume/rollback require the operator to echo the
 * preview fingerprint, record the confirmation in the append-only
 * authorization log, and delegate every machine check to the library.
 */
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

const RUNNER = join('scripts', 'upgrade-v0.2.mjs')

function run(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', cwd: process.cwd() })
}

function planJsonFrom(output) {
  const begin = output.indexOf('PLAN-JSON-BEGIN\n')
  const end = output.indexOf('PLAN-JSON-END')
  assert.ok(begin >= 0 && end > begin, `plan json markers missing:\n${output}`)
  return JSON.parse(output.slice(begin + 'PLAN-JSON-BEGIN\n'.length, end))
}

function fingerprintFrom(output) {
  const match = output.match(/^fingerprint: ([0-9a-f]{64})$/m)
  assert.ok(match, `fingerprint line missing:\n${output}`)
  return match[1]
}

async function git(cwd, ...args) {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim()
}

async function fixture(name) {
  const home = await mkdtemp(join(tmpdir(), `clickvibe-upgrade-runner-${name}-`))
  const repository = join(home, 'repo')
  const root = join(home, '.clickvibe')
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'config.yaml'), `repos:\n  o/r: ${repository}\nfetchTtlSeconds: 45\n`, { mode: 0o600 })
  await mkdir(join(root, 'state', 'o', 'r', 'issue-9'), { recursive: true })
  await writeFile(join(root, 'state', 'o', 'r', 'issue-9', 'workflow.json'), '{"legacy":true}\n')
  return { home, repository, root }
}

async function clickvibeEntries(root) {
  try {
    return (await readdir(root)).sort()
  } catch {
    return []
  }
}

test('preview prints the plan and fingerprint and writes nothing', async (t) => {
  const item = await fixture('preview')
  t.after(() => rm(item.home, { recursive: true, force: true }))
  const before = await clickvibeEntries(item.root)

  const result = run(['preview', '--home', item.home])
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`)
  const fingerprint = fingerprintFrom(result.stdout)
  const plan = planJsonFrom(result.stdout)
  assert.equal(plan.paths.root, item.root)
  assert.match(result.stdout, /state-v0\.1-backup-/)
  assert.match(result.stdout, /o\/r/)

  assert.deepEqual(await clickvibeEntries(item.root), before, 'preview must be zero-write')
})

test('apply with a mismatched fingerprint echo is rejected before any write', async (t) => {
  const item = await fixture('wrong-echo')
  t.after(() => rm(item.home, { recursive: true, force: true }))
  const preview = run(['preview', '--home', item.home])
  assert.equal(preview.status, 0, preview.stderr)
  const planFile = join(item.home, 'plan.json')
  await writeFile(planFile, JSON.stringify(planJsonFrom(preview.stdout)))

  const result = run(['apply', '--plan', planFile, '--fingerprint', '0'.repeat(64), '--home', item.home])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fingerprint/)

  const entries = await clickvibeEntries(item.root)
  assert.equal(entries.includes('upgrade-v0.2.json'), false, 'no journal may exist')
  assert.equal(entries.includes('upgrade-v0.2-authorization.log'), false, 'no authorization record for a rejected echo')
  assert.equal(entries.includes('upgrade-v0.2.lock'), false, 'no lock may exist')
})

test('apply with the echoed fingerprint records authorization and reaches verified', async (t) => {
  const item = await fixture('verified')
  t.after(() => rm(item.home, { recursive: true, force: true }))
  const preview = run(['preview', '--home', item.home])
  assert.equal(preview.status, 0, preview.stderr)
  const fingerprint = fingerprintFrom(preview.stdout)
  const planFile = join(item.home, 'plan.json')
  await writeFile(planFile, JSON.stringify(planJsonFrom(preview.stdout)))

  const result = run(['apply', '--plan', planFile, '--fingerprint', fingerprint, '--home', item.home])
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

  const journal = JSON.parse(await readFile(join(item.root, 'upgrade-v0.2.json'), 'utf8'))
  assert.equal(journal.phase, 'verified')
  assert.equal(journal.planFingerprint, fingerprint)

  const authorization = (await readFile(join(item.root, 'upgrade-v0.2-authorization.log'), 'utf8')).trim().split('\n')
  assert.equal(authorization.length, 1)
  const record = JSON.parse(authorization[0])
  assert.equal(record.entry, 'offline-runner-1')
  assert.equal(record.command, 'apply')
  assert.equal(record.fingerprint, fingerprint)

  const entries = await clickvibeEntries(item.root)
  const backupName = entries.find((name) => name.startsWith('state-v0.1-backup-'))
  assert.ok(backupName, `cold backup missing: ${entries.join(', ')}`)
  const backupMarker = await readFile(join(item.root, backupName, 'o', 'r', 'issue-9', 'workflow.json'), 'utf8')
  assert.equal(backupMarker, '{"legacy":true}\n')
  const activeConfig = await readFile(join(item.root, 'config.yaml'), 'utf8')
  assert.match(activeConfig, /schemaVersion: 1/)
})

test('a facts-changed apply still records the attempted authorization and writes no journal', async (t) => {
  const item = await fixture('facts-changed')
  t.after(() => rm(item.home, { recursive: true, force: true }))
  const preview = run(['preview', '--home', item.home])
  assert.equal(preview.status, 0, preview.stderr)
  const fingerprint = fingerprintFrom(preview.stdout)
  const planFile = join(item.home, 'plan.json')
  await writeFile(planFile, JSON.stringify(planJsonFrom(preview.stdout)))

  await writeFile(join(item.root, 'state', 'o', 'r', 'issue-9', 'workflow.json'), '{"legacy":false}\n')
  const result = run(['apply', '--plan', planFile, '--fingerprint', fingerprint, '--home', item.home])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /facts/i)

  const record = JSON.parse(await readFile(join(item.root, 'upgrade-v0.2-authorization.log'), 'utf8'))
  assert.equal(record.fingerprint, fingerprint)
  assert.equal(await clickvibeEntries(item.root).then((e) => e.includes('upgrade-v0.2.json')), false)
})

test('recovery without an unfinished journal refuses and points back to preview', async (t) => {
  const item = await fixture('recovery')
  t.after(() => rm(item.home, { recursive: true, force: true }))
  const preview = run(['preview', '--home', item.home])
  assert.equal(preview.status, 0, preview.stderr)
  const planFile = join(item.home, 'plan.json')
  await writeFile(planFile, JSON.stringify(planJsonFrom(preview.stdout)))
  // An authorized apply is not run here, so no journal exists yet.

  const recovery = run(['recovery', '--home', item.home])
  assert.equal(recovery.status, 2, `stdout:\n${recovery.stdout}\nstderr:\n${recovery.stderr}`)
  assert.match(recovery.stderr, /recovery unavailable/)
  assert.equal(recovery.stdout.includes('PLAN-JSON-BEGIN'), false)
})
