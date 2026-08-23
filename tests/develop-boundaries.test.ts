import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentChunk } from '../src/agent/agent-stream.ts'
import { authorizationDigest, makeAuthorizationInput, parseDependencies } from '../src/agent/develop.ts'
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

test('merge authorization binds the exact PR base and a well-formed manual override', () => {
  const base = {
    action: 'merge',
    url: 'https://github.com/ai-daming/clickvibe/issues/49',
    target: {
      prNumber: '29',
      branch: 'r-issue-49',
      head: 'abcdef1234567890',
      baseRef: 'main',
      baseSha: '1234567890abcdef',
      mergeFlag: '--merge',
    },
  }
  const parsed = makeAuthorizationInput({
    ...base,
    override: { skipped: ['review-hash', 'contract-changed', 'review-hash'], reason: ' 人工确认可合并 ' },
  })
  assert.deepEqual(parsed.target, base.target)
  assert.deepEqual(parsed.override, {
    skipped: ['review-hash', 'contract-changed'],
    reason: '人工确认可合并',
  })
  const changedBase = makeAuthorizationInput({ ...base, target: { ...base.target, baseSha: 'fedcba0987654321' } })
  assert.notEqual(authorizationDigest(parsed, null), authorizationDigest(changedBase, null))
  assert.equal(makeAuthorizationInput({ ...base, override: true }).override, undefined)
  assert.throws(() => makeAuthorizationInput({ ...base, target: { ...base.target, baseSha: '' } }), /合并授权目标无效/)
  assert.throws(
    () => makeAuthorizationInput({ ...base, override: { skipped: ['github-protection'], reason: 'x' } }),
    /门禁项无效/,
  )
  assert.throws(() => makeAuthorizationInput({ ...base, override: { skipped: [], reason: 'x' } }), /门禁项无效/)
  assert.throws(
    () => makeAuthorizationInput({ ...base, override: { skipped: ['review-hash'], reason: '   ' } }),
    /放行原因无效/,
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
