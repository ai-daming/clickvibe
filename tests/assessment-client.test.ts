import assert from 'node:assert/strict'
import test from 'node:test'
import { currentAssessmentSession, currentAssessmentModel } from '../src/client/assessment-model.ts'
import { getClientContext, setClientContext } from '../src/client/panel-state.ts'

test('assessment uses the visible blank session and its model, not the session catalog', async () => {
  const previous = getClientContext()
  let selected: string | undefined = 'blank-session'
  const loaded: string[] = []
  const model = { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' }
  // Harness UiSession.adapter.current exposes a StandardSourceBinding.key.
  // SessionListState is a catalog (ids/byId/phase), with no current field.
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ ids: ['other', 'blank-session'], byId: {}, phase: 'ready' }) } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: selected }) } } },
    modelDirectories: {
      directoryFor: (id: string) => ({
        load: async () => {
          loaded.push(id)
          return { current: model, routable: true }
        },
      }),
    },
  }
  try {
    setClientContext({ get: (name: string) => services[name] } as never)
    assert.equal(currentAssessmentSession(), 'blank-session')
    assert.deepEqual(await currentAssessmentModel(), model)
    selected = 'other'
    assert.deepEqual(await currentAssessmentModel(), model)
    assert.deepEqual(loaded, ['blank-session', 'other'])
    selected = undefined
    assert.equal(currentAssessmentSession(), undefined)
    await assert.rejects(currentAssessmentModel(), /打开对话/)
    assert.equal(loaded.length, 2)
    delete services.uiSession
    await assert.rejects(currentAssessmentModel(), /当前会话接口/)
  } finally {
    setClientContext(previous as never)
  }
})

test('model service failure is distinct from missing model selection', async () => {
  const previous = getClientContext()
  const services: Record<string, unknown> = {
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'blank' }) } } },
  }
  try {
    setClientContext({ get: (name: string) => services[name] } as never)
    await assert.rejects(currentAssessmentModel(), /模型选择接口/)
    for (const result of [
      { current: null, routable: null },
      { current: { provider: 'p', model: 'm' }, routable: false },
    ]) {
      services.modelDirectories = { directoryFor: () => ({ load: async () => result }) }
      await assert.rejects(currentAssessmentModel(), /选择可用模型/)
    }
  } finally {
    setClientContext(previous as never)
  }
})
