/** Optional real-host integration: isolated storage and a scripted local provider, zero network model calls. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const host = process.env.CLICKVIBE_HARNESS_CHECKOUT
if (!host) throw new Error('Set CLICKVIBE_HARNESS_CHECKOUT to a built Harness checkout')
const work = process.cwd()
const req = createRequire(`${host}/packages/core/agent/package.json`)
const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')))
const load = async path => import(pathToFileURL(`${host}/packages/${path}/lib/index.js`))
const { default: LlmRuntime, LlmAdapter } = await load('llm/llm')
const { executeAssessment } = await import(pathToFileURL(`${work}/src/infra/assessment-harness.ts`))
const { readAssessmentOutput } = await import(pathToFileURL(`${work}/src/agent/assessment-output.ts`))
const root = await mkdtemp(join(tmpdir(), 'clickvibe-real-harness-'))
const ctx = new Context()
let calls = 0
let forbiddenWrites = 0
class Adapter extends LlmAdapter {
  async *stream(options) {
    calls++
    const names = options.tools.map(tool => tool.name)
    assert.ok(names.includes('assessment_read_file'))
    if (calls === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'late-test', name: 'late_write', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Implementation Gate: NEEDS_EVIDENCE\nWork: o/r#177\n需要取得现场事实。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  await ctx.plugin(LlmRuntime)
  for (const path of ['core/session', 'session/session-projection', 'core/system-prompt', 'core/tools', 'core/agent']) await ctx.plugin((await load(path)).default)
  await ctx.plugin((await load('session/session-persistence-jsonl')).default, { root, compression: 'none' })
  await ctx.plugin((await load('core/agent-loop')).default, { agents: [] })
  ctx.llm.registerAdapter(['assessment-test'], new Adapter())
  ctx.on('agent/created', ({agent}) => { agent.ctx.tools.register({name:'late_write', description:'Forbidden late tool', parameters:{type:'object',properties:{}}, output:{schema:{type:'string'},render:value=>[{type:'text',text:value}]}, execute: async () => { forbiddenWrites++; return 'WRITTEN' }}) })
  const run = { id: randomUUID(), sessionId: randomUUID(), messageId: randomUUID(), input: { repoPath: work, repoKey: 'o/r', url: 'https://github.com/o/r/issues/177', body: '## 目标\n验证', title: 'Smoke', baseOid: '7aca625f44b9858ebee2e97c7b65f155e4a2d358', model: { provider: 'assessment-test', model: 'test' } } }
  const events = await executeAssessment(ctx, run, 'Use impl-gate.', new AbortController().signal)
  assert.match(readAssessmentOutput(events, run.messageId), /NEEDS_EVIDENCE/)
  assert.equal(calls, 2)
  assert.equal(forbiddenWrites, 0)
  console.log(JSON.stringify({ success: true, realAgentFactory: true, realPersistence: true, readOnlyToolSurface: true, lateScopedWriteBlocked: forbiddenWrites === 0, networkModelCalls: 0, events: events.length }))
} finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
