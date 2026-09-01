/**
 * Write confirmation transactions (issue #131 slice B, ADR-0010 §5/§9).
 *
 * Every test here is a design §9/§13 interleaving, not a straight line:
 * marker persistence failure, uncertain write outcomes, readback
 * match/mismatch, lease serialization and read queueing, restart recovery.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubGatewayOwner, type GithubGatewayOwner } from '../src/github/gateway-owner.ts'
import { GithubRestReader } from '../src/github/rest.ts'
import {
  GITHUB_WRITE_OPERATIONS,
  type GithubWriteSpec,
  githubWriteRecover,
  runWriteTransaction,
} from '../src/github/writes.ts'

interface CannedStep {
  command: string
  stdin?: string
}

function makeReader(handle: (step: CannedStep) => Promise<{ exitCode: number; text: string }>): {
  reader: GithubRestReader
  owner: GithubGatewayOwner
  calls: CannedStep[]
} {
  const owner = createGithubGatewayOwner()
  const calls: CannedStep[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string; stdin?: string }) => {
        calls.push({ command: spec.command, stdin: spec.stdin })
        const result = await handle({ command: spec.command, stdin: spec.stdin })
        return { exitCode: result.exitCode, stdout: { text: result.text }, stderr: { text: '' } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { owner, minimumIntervalMs: 0 })
  return { reader, owner, calls }
}

const ok = (body: unknown, status = 200) => `HTTP/1.1 ${status}\n\n${JSON.stringify(body)}`
const httpError = (status: number, message: string) => `HTTP/1.1 ${status}\n\n${JSON.stringify({ message })}`

interface CommentInput {
  repoKey: string
  number: number
  body: string
}

const commentSpec: GithubWriteSpec<CommentInput, { id: number }> = {
  id: 'test-issue-comment',
  keys: (input) => [`${input.repoKey}/issues/${input.number}`, `repo:${input.repoKey}`],
  priority: 'critical',
  deadlineMs: 30_000,
  maxPages: 2,
  repeatable: false,
  dispatch: (reader, input) =>
    reader.mutate<{ id: number }>(`repos/${input.repoKey}/issues/${input.number}/comments`, 'POST', {
      body: input.body,
    }),
  readback: {
    run: (reader, input) =>
      reader.json<Array<{ body: string }>>(`repos/${input.repoKey}/issues/${input.number}/comments`),
    confirms: (input, observation) =>
      Array.isArray(observation) && observation.some((entry) => entry.body === input.body),
  },
}

const input = (): CommentInput => ({ repoKey: 'o/r', number: 5, body: 'delivery' })

test('marker persistence failure dispatches zero writes and fails fast', async () => {
  const { reader, owner, calls } = makeReader(async () => ({ exitCode: 0, text: ok({ id: 1 }, 201) }))
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.reject(new Error('disk full')),
  })
  assert.equal(outcome.outcome, 'failed')
  assert.equal(calls.length, 0, 'marker failure must mean zero gh dispatch')
  const kinds = owner.lifecycleEvents().map((event) => event.kind)
  assert.equal(kinds.filter((kind) => kind === 'dispatched').length, 0)
})

test('a non-repeatable write without a marker hook is a configuration failure, zero dispatch', async () => {
  const { reader, owner, calls } = makeReader(async () => ({ exitCode: 0, text: ok({ id: 1 }, 201) }))
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input())
  assert.equal(outcome.outcome, 'failed')
  assert.equal(calls.length, 0)
  void owner
})

test('happy path: one write, invalidation before readback, predicate confirms', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 9 }, 201) }
    return { exitCode: 0, text: ok([{ body: 'delivery' }]) }
  })
  // Pre-seed the observation cache so invalidation is observable.
  let loads = 0
  await reader.cachedResource(
    'o/r/issues/5',
    null,
    async () => {
      loads += 1
      return { updated_at: 'old' }
    },
    { ttlMs: 60_000 },
  )
  assert.equal(loads, 1)

  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'confirmed')
  if (outcome.outcome !== 'confirmed') return
  assert.equal(outcome.value.id, 9)
  assert.equal(calls.filter((call) => call.command.includes('--method POST')).length, 1, 'exactly one write attempt')

  const events = owner.lifecycleEvents()
  const kinds = events.map((event) => event.kind)
  const invalidatedAt = events.find((event) => event.kind === 'write-invalidated')?.at ?? -1
  const readbackAt = events.find((event) => event.kind === 'readback-settled')?.at ?? -1
  assert.ok(kinds.includes('write-invalidated'), 'invalidation is part of the stream')
  assert.ok(kinds.includes('readback-settled'))
  assert.ok(invalidatedAt <= readbackAt, 'invalidation precedes the readback settlement')

  // The invalidated observation is gone: the next cached read re-loads.
  await reader.cachedResource(
    'o/r/issues/5',
    null,
    async () => {
      loads += 1
      return { updated_at: 'new' }
    },
    { ttlMs: 60_000 },
  )
  assert.equal(loads, 2, 'write invalidation evicted the cached observation')

  const metrics = owner.lifecycleMetrics()
  assert.equal(metrics.writeReadbacks, 1)
  assert.equal(metrics.unknowns, 0)
})

test('explicit 4xx rejection is failed — no readback, no invalidation', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: httpError(422, 'Validation Failed') }
    return { exitCode: 0, text: ok([]) }
  })
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'failed')
  assert.equal(calls.filter((call) => !call.command.includes('--method POST')).length, 0, 'no readback dispatch')
  assert.equal(owner.lifecycleEvents().filter((event) => event.kind === 'write-invalidated').length, 0)
})

test('transport failure with matching readback is confirmed (GitHub executed)', async () => {
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: 'connection reset by peer' }
    return { exitCode: 0, text: ok([{ body: 'delivery' }]) }
  })
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'confirmed', 'the authoritative readback settles what the lost response could not')
})

test('transport failure with mismatching readback is unknown, never failed', async () => {
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 1, text: 'connection reset by peer' }
    return { exitCode: 0, text: ok([{ body: 'something-else' }]) }
  })
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'unknown')
  const terminal = owner.lifecycleEvents().find((event) => event.kind === 'terminal')
  assert.ok(terminal && terminal.kind === 'terminal' && terminal.outcome === 'unknown')
  assert.equal(owner.lifecycleMetrics().unknowns, 1)
})

test('readback failure is unknown while the write attempt stays exactly one', async () => {
  let posts = 0
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) {
      posts += 1
      return { exitCode: 0, text: ok({ id: 3 }, 201) }
    }
    return { exitCode: 1, text: 'readback transport failure' }
  })
  const outcome = await runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'unknown')
  assert.equal(posts, 1)
  assert.equal(calls.filter((call) => call.command.includes('--method POST')).length, 1)
})

test('two writes on the same resource serialize: dispatch two strictly after readback one', async () => {
  const sequence: string[] = []
  let currentBody = ''
  const { reader, owner } = makeReader(async (step) => {
    const isPost = step.command.includes('--method POST')
    if (isPost) {
      currentBody = JSON.parse(step.stdin ?? '{}').body
      sequence.push(`${currentBody === 'first' ? 'w1' : 'w2'}-dispatch`)
      return { exitCode: 0, text: ok({ id: 1 }, 201) }
    }
    sequence.push(`${currentBody === 'first' ? 'w1' : 'w2'}-readback`)
    return { exitCode: 0, text: ok([{ body: currentBody }]) }
  })
  const first = runWriteTransaction(
    owner,
    reader,
    commentSpec,
    { repoKey: 'o/r', number: 5, body: 'first' },
    { persistMarker: () => Promise.resolve() },
  )
  const second = runWriteTransaction(
    owner,
    reader,
    commentSpec,
    { repoKey: 'o/r', number: 5, body: 'second' },
    { persistMarker: () => Promise.resolve() },
  )
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.outcome, 'confirmed')
  assert.equal(b.outcome, 'confirmed')
  assert.deepEqual(sequence, ['w1-dispatch', 'w1-readback', 'w2-dispatch', 'w2-readback'])
})

test('an affected-resource read queues behind the write transaction', async () => {
  let releaseWrite: (() => void) | null = null
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let readDispatchedBeforeRelease = false
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) {
      await writeGate
      return { exitCode: 0, text: ok({ id: 1 }, 201) }
    }
    if (step.command.includes('issues/5/comments') && releaseWrite) {
      readDispatchedBeforeRelease = true
    }
    return { exitCode: 0, text: ok([{ body: 'delivery' }]) }
  })
  const transaction = runWriteTransaction(owner, reader, commentSpec, input(), {
    persistMarker: () => Promise.resolve(),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const queuedRead = reader.cachedResource(
    'o/r/issues/5/comments',
    null,
    async () => {
      loads += 1
      return [{ body: 'delivery' }]
    },
    { ttlMs: 60_000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(readDispatchedBeforeRelease, false, 'the read must not dispatch while the lease is held')
  releaseWrite?.()
  await transaction
  await queuedRead
  assert.equal(loads, 1)
  void calls
})

let loads = 0

test('writes on disjoint resources run concurrently', async () => {
  const releases: Array<() => void> = []
  const gates = [0, 1].map(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
  )
  const started: string[] = []
  let currentBody = ''
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) {
      currentBody = JSON.parse(step.stdin ?? '{}').body
      started.push(currentBody)
      await gates[currentBody === 'a' ? 0 : 1]
      return { exitCode: 0, text: ok({ id: 1 }, 201) }
    }
    const issueNumber = step.command.includes('issues/1/') ? 'a' : 'b'
    return { exitCode: 0, text: ok([{ body: issueNumber }]) }
  })
  // Disjoint means different repositories: two writes in ONE repo share the
  // `repo:` aggregate lease and correctly serialize (the serialization test
  // covers that half).
  const one = runWriteTransaction(
    owner,
    reader,
    commentSpec,
    { repoKey: 'o/one', number: 1, body: 'a' },
    { persistMarker: () => Promise.resolve() },
  )
  const two = runWriteTransaction(
    owner,
    reader,
    commentSpec,
    { repoKey: 'o/two', number: 2, body: 'b' },
    { persistMarker: () => Promise.resolve() },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual([...started].sort(), ['a', 'b'], 'disjoint leases do not serialize each other')
  for (const release of releases) release()
  assert.equal((await one).outcome, 'confirmed')
  assert.equal((await two).outcome, 'confirmed')
})

test('restart recovery runs the readback ONLY — zero write dispatch, ever', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 1 }, 201) }
    return { exitCode: 0, text: ok([{ body: 'delivery' }]) }
  })
  const confirmed = await githubWriteRecover(owner, reader, commentSpec, input())
  assert.equal(confirmed.outcome, 'confirmed')
  assert.equal(calls.filter((call) => call.command.includes('--method POST')).length, 0)

  const {
    reader: reader2,
    owner: owner2,
    calls: calls2,
  } = makeReader(async () => ({
    exitCode: 0,
    text: ok([{ body: 'not-ours' }]),
  }))
  const unknown = await githubWriteRecover(owner2, reader2, commentSpec, input())
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(calls2.filter((call) => call.command.includes('--method POST')).length, 0)
  void reader
})

// ---------------------------------------------------------------------------
// Family specs (slice B c2): declarative policies exercised end to end.

test('family pr-merge: PUT head-CAS merge, readback confirms merged_at', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method PUT')) return { exitCode: 0, text: ok({ merged: true }, 200) }
    return {
      exitCode: 0,
      text: ok({ state: 'closed', merged_at: '2026-09-01T00:00:00Z', head: { sha: 'deadbee' } }),
    }
  })
  const spec = GITHUB_WRITE_OPERATIONS['pr-merge'] as GithubWriteSpec<
    { repoKey: string; number: number; headRefOid: string; issueNumber: number },
    unknown
  >
  const outcome = await runWriteTransaction(owner, reader, spec, {
    repoKey: 'o/r',
    number: 7,
    headRefOid: 'deadbee',
    issueNumber: 122,
  })
  assert.equal(outcome.outcome, 'confirmed')
  const put = calls.find((call) => call.command.includes('--method PUT'))
  assert.ok(put, 'merge dispatches as a REST PUT')
  assert.match(put?.command ?? '', /repos\/o\/r\/pulls\/7\/merge/)
  const body = JSON.parse(put?.stdin ?? '{}') as Record<string, unknown>
  assert.equal(body.sha, 'deadbee', 'the head CAS travels in the body')
  assert.equal(body.merge_method, 'merge')
  assert.equal(body.commit_message, 'Closes #122')
  // An unmerged readback is unknown, never confirmed.
  const unmerged = makeReader(async () => ({ exitCode: 0, text: ok({ state: 'open' }) }))
  const second = await runWriteTransaction(unmerged.owner, unmerged.reader, spec, {
    repoKey: 'o/r',
    number: 7,
    headRefOid: 'deadbee',
    issueNumber: 122,
  })
  assert.equal(second.outcome, 'unknown')
  // review CF2: a merged PR whose head is NOT the CAS'd head is someone
  // else's merge — it must not confirm ours.
  const differentHead = makeReader(async (step) => {
    if (step.command.includes('--method PUT')) return { exitCode: 0, text: ok({ merged: true }, 200) }
    return {
      exitCode: 0,
      text: ok({ state: 'closed', merged_at: '2026-09-01T00:00:00Z', head: { sha: 'cafebabecafebabe' } }),
    }
  })
  const third = await runWriteTransaction(differentHead.owner, differentHead.reader, spec, {
    repoKey: 'o/r',
    number: 7,
    headRefOid: 'deadbee',
    issueNumber: 122,
  })
  assert.equal(third.outcome, 'unknown', 'a different head merged is not our merge')
})

test('family issue-close: PATCH state, readback confirms CLOSED', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method PATCH')) return { exitCode: 0, text: ok({ state: 'closed' }) }
    return { exitCode: 0, text: ok({ state: 'closed', number: 122 }) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['issue-close'] as GithubWriteSpec<{ repoKey: string; number: number }, unknown>
  const outcome = await runWriteTransaction(owner, reader, spec, { repoKey: 'o/r', number: 122 })
  assert.equal(outcome.outcome, 'confirmed')
  const patch = calls.find((call) => call.command.includes('--method PATCH'))
  assert.match(patch?.command ?? '', /repos\/o\/r\/issues\/122/)
  assert.deepEqual(JSON.parse(patch?.stdin ?? '{}'), { state: 'closed' })
})

test('family issue-comment-create: POST body, readback finds the exact comment', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 5 }, 201) }
    return {
      exitCode: 0,
      text: ok([
        { id: 1, body: 'noise' },
        { id: 5, body: 'exact-body' },
      ]),
    }
  })
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const outcome = await runWriteTransaction(
    owner,
    reader,
    spec,
    {
      repoKey: 'o/r',
      number: 9,
      body: 'exact-body',
    },
    { persistMarker: () => Promise.resolve() },
  )
  assert.equal(outcome.outcome, 'confirmed')
  const post = calls.find((call) => call.command.includes('--method POST'))
  assert.match(post?.command ?? '', /repos\/o\/r\/issues\/9\/comments/)
  assert.equal(spec.repeatable, false, 'comment creation is non-repeatable: marker required')
})

test('family issue-update: PATCH body, readback confirms the rewritten body', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method PATCH'))
      return { exitCode: 0, text: ok({ updated_at: '2026-09-01T00:00:00Z' }) }
    return { exitCode: 0, text: ok({ body: 'rewritten-ledger' }) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['issue-update'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const outcome = await runWriteTransaction(owner, reader, spec, {
    repoKey: 'o/r',
    number: 9,
    body: 'rewritten-ledger',
  })
  assert.equal(outcome.outcome, 'confirmed')
  const patch = calls.find((call) => call.command.includes('--method PATCH'))
  assert.match(patch?.command ?? '', /repos\/o\/r\/issues\/9' --method PATCH/)
  assert.deepEqual(JSON.parse(patch?.stdin ?? '{}'), { body: 'rewritten-ledger' })
  assert.equal(spec.repeatable, true, 'body rewrite converges: repeatable without a marker')
  // A readback with a stale body proves nothing.
  const stale = makeReader(async (step) => {
    if (step.command.includes('--method PATCH')) return { exitCode: 0, text: ok({ updated_at: '' }) }
    return { exitCode: 0, text: ok({ body: 'old-body' }) }
  })
  const second = await runWriteTransaction(stale.owner, stale.reader, spec, {
    repoKey: 'o/r',
    number: 9,
    body: 'rewritten-ledger',
  })
  assert.equal(second.outcome, 'unknown')
})

test('family dependency-unlock-comment: skip the POST when the marker comment already exists', async () => {
  const posted: Array<{ body: string }> = []
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) {
      const body = JSON.parse(step.stdin ?? '{}').body as string
      posted.push({ body })
      return { exitCode: 0, text: ok({ id: 1 }, 201) }
    }
    return { exitCode: 0, text: ok(posted) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['dependency-unlock-comment'] as GithubWriteSpec<
    { repoKey: string; number: number; marker: string; body: string },
    unknown
  >
  const input = {
    repoKey: 'o/r',
    number: 9,
    marker: 'clickvibe:dependency-unlock:8',
    body: 'clickvibe:dependency-unlock:8 — 依赖已完成,自动更新',
  }
  const first = await runWriteTransaction(owner, reader, spec, input)
  assert.equal(first.outcome, 'confirmed')
  const second = await runWriteTransaction(owner, reader, spec, input)
  assert.equal(second.outcome, 'confirmed', 'the second run converges on the existing comment')
  assert.equal(
    calls.filter((call) => call.command.includes('--method POST')).length,
    1,
    'check-then-POST under the lease posts at most once',
  )
  assert.equal(spec.repeatable, true, 'convergent family: no durable marker required')
})

test('family pr-create: POST pulls with PR-by-head readback', async () => {
  const { reader, owner, calls } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ number: 31 }, 201) }
    if (step.command.includes('/pulls?state=open')) {
      return { exitCode: 0, text: ok([{ number: 31, head: { ref: 'r-issue-17' } }]) }
    }
    return { exitCode: 0, text: ok({}) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['pr-create'] as GithubWriteSpec<
    { repoKey: string; branch: string; base: string; title: string; body: string },
    unknown
  >
  const input = {
    repoKey: 'o/r',
    branch: 'r-issue-17',
    base: 'main',
    title: 'Deliver issue #17',
    body: 'Closes #17',
  }
  const outcome = await runWriteTransaction(owner, reader, spec, input, {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(outcome.outcome, 'confirmed')
  const post = calls.find((call) => call.command.includes('--method POST'))
  assert.match(post?.command ?? '', /repos\/o\/r\/pulls/)
  const body = JSON.parse(post?.stdin ?? '{}') as Record<string, unknown>
  assert.equal(body.head, 'r-issue-17')
  assert.equal(body.base, 'main')
  assert.equal(body.title, 'Deliver issue #17')
  assert.equal(spec.repeatable, false, 'PR creation is non-repeatable: marker required')
  // A PR list without the branch head proves nothing.
  const missing = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ number: 31 }, 201) }
    if (step.command.includes('/pulls?state=open')) return { exitCode: 0, text: ok([]) }
    return { exitCode: 0, text: ok({}) }
  })
  const second = await runWriteTransaction(missing.owner, missing.reader, spec, input, {
    persistMarker: () => Promise.resolve(),
  })
  assert.equal(second.outcome, 'unknown')
})

test('family pr-create without a marker hook fails before any dispatch', async () => {
  const { reader, owner, calls } = makeReader(async () => ({ exitCode: 0, text: ok({ number: 31 }, 201) }))
  const spec = GITHUB_WRITE_OPERATIONS['pr-create'] as GithubWriteSpec<
    { repoKey: string; branch: string; base: string; title: string; body: string },
    unknown
  >
  const outcome = await runWriteTransaction(owner, reader, spec, {
    repoKey: 'o/r',
    branch: 'r-issue-17',
    base: 'main',
    title: 't',
    body: 'b',
  })
  assert.equal(outcome.outcome, 'failed')
  assert.equal(calls.length, 0, 'zero dispatch without the durable marker')
})

test('review F1: a comment beyond the first page is still confirmed by the paginated readback', async () => {
  const noise = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `noise-${index}` }))
  const pages: Array<Array<{ id: number; body: string }>> = [noise, [{ id: 101, body: 'exact-body' }]]
  const fetchedPages: number[] = []
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 101 }, 201) }
    const page = Number(step.command.match(/[?&]page=(\d+)/)?.[1] ?? 1)
    fetchedPages.push(page)
    return { exitCode: 0, text: ok(pages[page - 1] ?? []) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const outcome = await runWriteTransaction(
    owner,
    reader,
    spec,
    { repoKey: 'o/r', number: 9, body: 'exact-body' },
    { persistMarker: () => Promise.resolve() },
  )
  assert.equal(outcome.outcome, 'confirmed', 'the record on page 2 must not read as unknown')
  assert.deepEqual(fetchedPages, [1, 2], 'the readback pages through the whole in-budget result set')
})

test('review F1: a record beyond the declared page budget settles unknown, not failed', async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `noise-${index}` }))
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) return { exitCode: 0, text: ok({ id: 201 }, 201) }
    return { exitCode: 0, text: ok(page) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['issue-comment-create'] as GithubWriteSpec<
    { repoKey: string; number: number; body: string },
    unknown
  >
  const outcome = await runWriteTransaction(
    owner,
    reader,
    spec,
    { repoKey: 'o/r', number: 9, body: 'beyond-budget' },
    { persistMarker: () => Promise.resolve() },
  )
  assert.equal(outcome.outcome, 'unknown', 'a cost-bound breach is unprovable, never a provable failure')
})

test('review F1: the dependency-unlock marker scan finds an existing comment on page 2 and skips the POST', async () => {
  const markerComment = { id: 5, body: 'clickvibe:dependency-unlock:8 — done' }
  const noise = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `noise-${index}` }))
  const pages = [noise, [markerComment]]
  let posts = 0
  const { reader, owner } = makeReader(async (step) => {
    if (step.command.includes('--method POST')) {
      posts += 1
      return { exitCode: 0, text: ok({ id: 9 }, 201) }
    }
    const page = Number(step.command.match(/[?&]page=(\d+)/)?.[1] ?? 1)
    return { exitCode: 0, text: ok(pages[page - 1] ?? []) }
  })
  const spec = GITHUB_WRITE_OPERATIONS['dependency-unlock-comment'] as GithubWriteSpec<
    { repoKey: string; number: number; marker: string; body: string },
    unknown
  >
  const input = { repoKey: 'o/r', number: 9, marker: 'clickvibe:dependency-unlock:8', body: markerComment.body }
  const outcome = await runWriteTransaction(owner, reader, spec, input)
  assert.equal(outcome.outcome, 'confirmed')
  assert.equal(posts, 0, 'a marker beyond page 1 must still suppress the duplicate POST')
})
