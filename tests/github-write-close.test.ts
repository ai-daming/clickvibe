/**
 * close() × logical-write interleavings (issue #131 slice B, reviews F2/CF1):
 * every park point of a write transaction and a readback-only recovery —
 * queued lease, marker hook, pacing, running dispatch/readback, and the
 * close deadline sweep — must leave exactly ONE terminal whose outcome
 * agrees with the caller's.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubGatewayOwner } from '../src/github/gateway-owner.ts'
import { GithubRestReader } from '../src/github/rest.ts'
import {
  GITHUB_WRITE_OPERATIONS,
  type GithubWriteSpec,
  githubWriteRecover,
  runWriteTransaction,
} from '../src/github/writes.ts'

test('review F2: close() settles a queued write with one interrupted terminal and never strands the lease', async () => {
  const owner = createGithubGatewayOwner()
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        throw new Error('must not dispatch — the gateway is closed')
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  let releaseA: (() => void) | null = null
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const spec: GithubWriteSpec<{ repoKey: string }, unknown> = {
    id: 'test-gated-write',
    keys: () => ['o/r/issues/5', 'repo:o/r'],
    priority: 'normal',
    deadlineMs: 5_000,
    maxPages: 2,
    repeatable: true,
    dispatch: async () => {
      await gateA
      return {}
    },
    readback: {
      run: (read) => read.json('repos/o/r/issues/5'),
      confirms: () => true,
    },
  }
  const writeA = runWriteTransaction(owner, reader, spec, { repoKey: 'o/r' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const writeB = runWriteTransaction(owner, reader, spec, { repoKey: 'o/r' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const closing = owner.close({ drainMs: 100 })
  await assert.rejects(() => writeB, /排队写请求被中断/, 'the queued write is interrupted, not hanging')
  releaseA?.()
  const outcomeA = await writeA
  assert.equal(
    outcomeA.outcome,
    'unknown',
    'the running write settles unknown once its readback hits the closed gateway',
  )
  await closing
  const events = owner.lifecycleEvents()
  const bDeclared = events.filter((event) => event.kind === 'declared')
  assert.equal(bDeclared.length, 2, 'both writes are lifecycle-visible before they block')
  const terminals = events.filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 2, 'exactly one terminal per logical request')
  const outcomes = terminals.map((event) => (event as { outcome: string }).outcome).sort()
  assert.deepEqual(
    outcomes,
    ['interrupted', 'unknown'],
    'the queued write is interrupted; the dispatch-attempted write is swept unknown (it may have executed)',
  )
})

test('review CF1: a transaction parked in its marker is swept interrupted and later fails with zero dispatch', async () => {
  const owner = createGithubGatewayOwner()
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        throw new Error('must not dispatch — the gateway closed before the marker resolved')
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  let releaseMarker: (() => void) | null = null
  const markerGate = new Promise<void>((resolve) => {
    releaseMarker = resolve
  })
  const spec: GithubWriteSpec<{ repoKey: string }, unknown> = {
    id: 'test-marker-parked',
    keys: () => ['o/r/issues/5', 'repo:o/r'],
    priority: 'normal',
    deadlineMs: 5_000,
    maxPages: 2,
    repeatable: false,
    dispatch: (read) => read.mutate('repos/o/r/issues/5/comments', 'POST', { body: 'x' }),
    readback: {
      run: (read) => read.json('repos/o/r/issues/5'),
      confirms: () => true,
    },
  }
  const transaction = runWriteTransaction(
    owner,
    reader,
    spec,
    { repoKey: 'o/r' },
    {
      persistMarker: async () => {
        await markerGate
      },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 50 })
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 1, 'the swept terminal is the only answer')
  assert.equal((terminals[0] as { outcome: string }).outcome, 'interrupted', 'pre-dispatch writes are interrupted')
  releaseMarker?.()
  const outcome = await transaction
  assert.equal(outcome.outcome, 'failed', 'the caller sees the write provably never happened')
  assert.equal(owner.lifecycleEvents().filter((event) => event.kind === 'terminal').length, 1)
})

test('review CF1: a transaction parked in its readback is swept unknown — it may have executed', async () => {
  const owner = createGithubGatewayOwner()
  let releaseReadback: (() => void) | null = null
  const readbackGate = new Promise<void>((resolve) => {
    releaseReadback = resolve
  })
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        if (spec.command.includes('--method POST'))
          return { exitCode: 0, stdout: { text: 'HTTP/1.1 201\n\n{"id":1}' }, stderr: { text: '' } }
        await readbackGate
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{}' }, stderr: { text: '' } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  const spec: GithubWriteSpec<{ repoKey: string }, unknown> = {
    id: 'test-readback-parked',
    keys: () => ['o/r/issues/5', 'repo:o/r'],
    priority: 'normal',
    deadlineMs: 5_000,
    maxPages: 2,
    repeatable: true,
    dispatch: (read) => read.mutate('repos/o/r/issues/5/comments', 'POST', { body: 'x' }),
    readback: {
      run: (read) => read.json('repos/o/r/issues/5'),
      confirms: () => true,
    },
  }
  const transaction = runWriteTransaction(owner, reader, spec, { repoKey: 'o/r' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 50 })
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 1)
  assert.equal((terminals[0] as { outcome: string }).outcome, 'unknown', 'a dispatched write is never guessed closed')
  releaseReadback?.()
  const outcome = await transaction
  assert.equal(outcome.outcome, 'unknown', 'caller and lifecycle agree on the single unknown answer')
  assert.equal(owner.lifecycleEvents().filter((event) => event.kind === 'terminal').length, 1)
})

test('review CF1 matrix: recovery with its authoritative GET running settles unknown — never interrupted', async () => {
  const owner = createGithubGatewayOwner()
  let releaseGet: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    releaseGet = resolve
  })
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        if (spec.command.includes('--method')) throw new Error('recovery must never write')
        await gate
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n[]' }, stderr: { text: '' } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const recovery = githubWriteRecover(owner, reader, spec, { repoKey: 'o/r', number: 5, body: 'exact-body' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 50 })
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 1, 'one authoritative terminal')
  assert.equal((terminals[0] as { outcome: string }).outcome, 'unknown', 'a dispatched GET is never guessed closed')
  releaseGet?.()
  const outcome = await recovery
  assert.equal(outcome.outcome, 'unknown', 'caller and lifecycle agree')
  assert.equal(owner.lifecycleEvents().filter((event) => event.kind === 'terminal').length, 1)
})

test('review CF1 matrix: recovery interrupted while pacing settles failed with one interrupted terminal', async () => {
  const owner = createGithubGatewayOwner()
  let releaseProbe: (() => void) | null = null
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        await probeGate
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n[]' }, stderr: { text: '' } }
      },
    },
  }
  // The first dispatch sets the pacing interval; the recovery readback then
  // sleeps between admission and run — exactly where close() must interrupt.
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 500 })
  const probe = reader.json('repos/o/r/issues/101').catch(() => 'probe interrupted')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const recovery = githubWriteRecover(owner, reader, spec, { repoKey: 'o/r', number: 5, body: 'exact-body' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 1 })
  const outcome = await recovery
  assert.equal(outcome.outcome, 'failed', 'the read provably never dispatched')
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  const recoveryTerminals = terminals.filter((event) => (event as { error?: unknown }).error !== undefined)
  assert.equal(
    (terminals.find((event) => (event as { outcome: string }).outcome === 'interrupted') as
      | { outcome: string }
      | undefined) !== undefined,
    true,
    'an interrupted terminal exists',
  )
  assert.equal(terminals.length, 2, 'probe and recovery each leave one terminal')
  assert.equal(
    commands.filter((command) => command.includes('issues/5')).length,
    0,
    'the recovery read never dispatched',
  )
  releaseProbe?.()
  await probe
})

test('review CF1 matrix: recovery queued behind unknown-budget probes settles failed with one interrupted terminal', async () => {
  const owner = createGithubGatewayOwner()
  let releaseProbe: (() => void) | null = null
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        await probeGate
        return { exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n[]' }, stderr: { text: '' } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  // Occupy the unknown-budget probe lanes (cap 2) so the recovery readback
  // stays queued behind them when close lands.
  const probes = [
    reader.json('repos/o/r/issues/101').catch(() => 'probe interrupted'),
    reader.json('repos/o/r/issues/102').catch(() => 'probe interrupted'),
  ]
  await new Promise((resolve) => setTimeout(resolve, 30))
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const recovery = githubWriteRecover(owner, reader, spec, { repoKey: 'o/r', number: 5, body: 'exact-body' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 50 })
  const outcome = await recovery
  assert.equal(outcome.outcome, 'failed')
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  const recoveryTerminal = terminals.find(
    (event) => (event as { requestId?: string }).requestId !== undefined && event.kind === 'terminal',
  )
  assert.ok(recoveryTerminal, 'the recovery request is lifecycle-visible')
  assert.equal(
    (recoveryTerminal as { outcome: string }).outcome,
    'interrupted',
    'queued-never-dispatched recovery may interrupt',
  )
  releaseProbe?.()
  await Promise.all(probes)
  assert.equal(
    commands.filter((command) => command.includes('issues/5')).length,
    0,
    'the recovery read never dispatched',
  )
})
