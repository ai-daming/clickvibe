import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentChunk } from '../src/agent/agent-stream.ts'
import { makeAuthorizationInput, parseDependencies } from '../src/agent/develop.ts'
import { LineBuffer } from '../src/infra/line-buffer.ts'

test('develop authorization accepts a valid Unicode origin branch', () => {
  assert.equal(
    makeAuthorizationInput({
      action: 'develop',
      url: 'https://github.com/o/r/issues/60',
      agent: 'codex',
      baseline: 'origin/发布/二期',
    }).baseline,
    'origin/发布/二期',
  )
})

test('LineBuffer consumes complete raw events while retaining only the partial line', () => {
  const buffer = new LineBuffer()
  const events = Array.from({ length: 2001 }, (_, index) =>
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `m${index}` } }),
  )
  const lines = buffer.appendChunk(`${events.join('\n')}\npartial`)
  const parsed = parseAgentChunk('codex', lines.join('\n'))
  assert.equal(parsed.lines.length, 2001)
  assert.equal(parsed.lines[0].text, '💬 m0')
  assert.equal(parsed.lines[2000].text, '💬 m2000')
  assert.deepEqual(buffer.appendChunk(' tail\r'), [])
  assert.deepEqual(buffer.appendChunk('\nnext\r'), ['partial tail'])
  assert.deepEqual(buffer.appendChunk('\nfinal'), ['next'])
  assert.deepEqual(buffer.flush(), ['final'])
  assert.deepEqual(buffer.flush(), [])
})

test('parseDependencies extracts Blocked by numbers from the 依赖 section', () => {
  assert.deepEqual(parseDependencies(`## 目标\n做 X\n\n## 依赖\n\nBlocked by #7`), [7])
  assert.deepEqual(parseDependencies(`## 依赖\n\nBlocked by #7, #8`), [7, 8])
  assert.deepEqual(parseDependencies(`## 依赖\n\n无`), [])
  assert.deepEqual(parseDependencies('## 目标\n无依赖,正常开发'), [])
  assert.deepEqual(parseDependencies(''), [])
  assert.deepEqual(parseDependencies(`## 依赖\n\nBlocked by #7\n\n## 验收标准\n- [ ] 通过 #7 的行为`), [7])
})
