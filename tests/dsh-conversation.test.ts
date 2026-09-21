import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openDshConversationDraft,
  resolveDshConversationDeps,
  type DshConversationDeps,
} from '../src/client/dsh-conversation.ts'

interface Harness {
  deps: DshConversationDeps
  createdPaths: string[]
  connected: string[]
  opened: string[]
  drafts: { sessionId: string; text: string }[]
  connectError: Error | null
  openError: Error | null
  conversation: DshConversationDeps['conversation']
}

function makeHarness(): Harness {
  const harness: Harness = {
    deps: undefined as unknown as DshConversationDeps,
    createdPaths: [],
    connected: [],
    opened: [],
    drafts: [],
    connectError: null,
    openError: null,
    conversation: null,
  }
  const scopeCtxBySession = new Map<string, object>([['session-blank-1', { scope: 'session-blank-1' }]])
  harness.deps = {
    workspaces: {
      async create({ path }: { path: string }) {
        harness.createdPaths.push(path)
        return { workspaceId: `ws:${path}` }
      },
    },
    uiWorkspace: {
      async connectWorkspace(workspaceId: string) {
        if (harness.connectError) throw harness.connectError
        harness.connected.push(workspaceId)
        return 'session-blank-1'
      },
      openSession(sessionId: string) {
        if (harness.openError) throw harness.openError
        harness.opened.push(sessionId)
      },
    },
    sessions: {
      scope(sessionId: string) {
        return scopeCtxBySession.get(sessionId)
      },
    },
    get conversation() {
      return harness.conversation
    },
    set conversation(value) {
      harness.conversation = value
    },
  }
  return harness
}

/** 标准conversation 服务:记录 setDraft、绝不发送。 */
function recordingConversation(harness: Harness): NonNullable<DshConversationDeps['conversation']> {
  return {
    input: {
      for(actx: unknown) {
        const sessionId = String((actx as { scope: string }).scope)
        return {
          setDraft(text: string) {
            harness.drafts.push({ sessionId, text })
          },
        }
      },
    },
  }
}

test('opens a blank conversation with the issue link as draft, never sending', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'https://github.com/o/r/issues/53')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.createdPaths, ['/repo/local'])
  assert.deepEqual(harness.connected, ['ws:/repo/local'])
  assert.deepEqual(harness.drafts, [{ sessionId: 'session-blank-1', text: 'https://github.com/o/r/issues/53' }])
  assert.deepEqual(harness.opened, ['session-blank-1'])
})

test('regression: navigation lives on uiWorkspace, not on the workspaces face', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  // Current DSH carves navigation out of the workspaces face: it only registers
  // paths, while connectWorkspace/openSession belong to uiWorkspace. A bridge
  // that calls workspaces.connectWorkspace fails with "... is not a function".
  assert.equal('connectWorkspace' in harness.deps.workspaces, false)
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.connected, ['ws:/repo/local'])
  assert.deepEqual(harness.opened, ['session-blank-1'])
})

test('navigation precedes the draft write because only retention materializes the scope', async () => {
  const calls: string[] = []
  const deps: DshConversationDeps = {
    workspaces: {
      async create() {
        return { workspaceId: 'ws' }
      },
    },
    uiWorkspace: {
      async connectWorkspace() {
        return 'session-blank-1'
      },
      openSession() {
        calls.push('openSession')
      },
    },
    sessions: {
      scope: () => ({}),
    },
    conversation: {
      input: {
        for: () => ({
          setDraft() {
            calls.push('setDraft')
          },
        }),
      },
    },
  }
  await openDshConversationDraft(deps, '/repo/local', 'https://github.com/o/r/issues/53')
  assert.deepEqual(calls, ['openSession', 'setDraft'])
})

test('workspace path is registered (idempotently by the host) on every call', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  await openDshConversationDraft(harness.deps, '/repo/local', 'url-1')
  await openDshConversationDraft(harness.deps, '/repo/local', 'url-2')
  // create is the single registration entry: host resolves by realpath, so a
  // repeat call reuses rather than duplicates.
  assert.deepEqual(harness.createdPaths, ['/repo/local', '/repo/local'])
  assert.equal(harness.connected.length, 2)
})

test('binds the discussion session before navigating', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  const bound: string[] = []
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url', async (sessionId) => {
    bound.push(sessionId)
    assert.deepEqual(harness.opened, [])
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(bound, ['session-blank-1'])
})

test('reports a readable error when the input service is missing but still navigates', async () => {
  const harness = makeHarness()
  harness.conversation = null
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'https://github.com/o/r/issues/53')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.warning ?? '', /草稿未预填.*conversation 输入服务未注入/)
  assert.deepEqual(harness.opened, ['session-blank-1'])
})

test('reports a readable error when the session scope cannot be resolved', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  ;(harness.deps.sessions as { scope(id: string): unknown }).scope = () => undefined
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.warning ?? '', /草稿未预填/)
  assert.deepEqual(harness.opened, ['session-blank-1'])
})

test('reports a readable warning when the draft write itself throws', async () => {
  const harness = makeHarness()
  harness.conversation = {
    input: {
      for: () => ({
        setDraft() {
          throw new Error('editor unavailable')
        },
      }),
    },
  }
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.warning ?? '', /草稿未预填.*editor unavailable/)
  assert.deepEqual(harness.opened, ['session-blank-1'])
})

test('surfaces workspace registration failures without navigating', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  harness.deps.workspaces.create = async () => {
    throw new Error('no such directory')
  }
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /workspace 注册失败.*no such directory/)
  assert.deepEqual(harness.opened, [])
})

test('surfaces blank-session connect failures without navigating', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  harness.connectError = new Error('host unavailable')
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /空白会话创建失败.*host unavailable/)
  assert.deepEqual(harness.opened, [])
})

test('surfaces discussion binding failures without navigating', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url', async () => {
    throw new Error('assessment gone')
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /讨论关联失败.*assessment gone/)
  assert.deepEqual(harness.opened, [])
})

test('surfaces navigation failures and never reaches the draft write', async () => {
  const harness = makeHarness()
  harness.conversation = recordingConversation(harness)
  harness.openError = new Error('layout torn down')
  const result = await openDshConversationDraft(harness.deps, '/repo/local', 'url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /DSH 会话打开失败.*layout torn down/)
  assert.deepEqual(harness.drafts, [])
})

test('resolveDshConversationDeps names the missing services', () => {
  const empty = resolveDshConversationDeps({ get: () => undefined })
  assert.deepEqual(empty, { missing: ['workspaces', 'uiWorkspace', 'sessions'] })

  const partial = resolveDshConversationDeps({
    get: (name: string) => (name === 'workspaces' ? { create: async () => ({ workspaceId: 'ws' }) } : undefined),
  })
  assert.deepEqual(partial, { missing: ['uiWorkspace', 'sessions'] })

  const full = resolveDshConversationDeps({
    get: (name: string) => {
      if (name === 'conversation') return { input: { for: () => ({ setDraft() {} }) } }
      if (name === 'uiWorkspace') return { connectWorkspace: async () => 's', openSession() {} }
      if (name === 'sessions') return { scope: () => ({}) }
      return { create: async () => ({ workspaceId: 'ws' }) }
    },
  })
  assert.ok(!('missing' in full))
  assert.equal(
    full.workspaces !== undefined &&
      full.uiWorkspace !== undefined &&
      full.sessions !== undefined &&
      full.conversation !== null,
    true,
  )
})
