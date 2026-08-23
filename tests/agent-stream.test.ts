import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentChunk, parseClaudeEvent, parseCodexEvent } from '../src/agent/agent-stream.ts'

const longMessage = 'x'.repeat(5000)

test('codex and claude use the same 4000-character display limit for messages', () => {
  const codex = parseCodexEvent(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: longMessage },
    }),
  )
  const claude = parseClaudeEvent(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: longMessage }] },
    }),
  )
  assert.equal(codex[0].text, claude[0].text)
  assert.equal(codex[0].text, `💬 ${'x'.repeat(4000)}…`)
})

test('agent streams expose session ids before completion', () => {
  assert.equal(
    parseAgentChunk(
      'codex',
      JSON.stringify({
        type: 'thread.started',
        thread_id: 'thread-123',
      }),
    ).sessionId,
    'thread-123',
  )
  assert.equal(
    parseAgentChunk(
      'claude',
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'session-123',
      }),
    ).sessionId,
    'session-123',
  )
})

test('codex renders command execution, reasoning and token_count with its own schema', () => {
  assert.deepEqual(
    parseCodexEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'pnpm test', aggregated_output: 'one\ntwo\n' },
      }),
    ),
    [
      { kind: 'command', text: '$ pnpm test' },
      { kind: 'command_output', text: 'one' },
      { kind: 'command_output', text: 'two' },
    ],
  )
  assert.equal(
    parseCodexEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'inspect the state' },
      }),
    )[0].kind,
    'reasoning',
  )
  assert.deepEqual(
    parseCodexEvent(
      JSON.stringify({
        type: 'token_count',
        input_tokens: 12,
        output_tokens: 7,
      }),
    )[0].usage,
    { inputTokens: 12, cachedInputTokens: undefined, outputTokens: 7, totalTokens: 19 },
  )
  assert.equal(
    parseCodexEvent(
      JSON.stringify({
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 42 } },
      }),
    )[0].usage?.totalTokens,
    42,
  )
})

test('claude renders thinking, tool_use and usage with its own schema', () => {
  const lines = parseClaudeEvent(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'inspect first' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
        ],
        usage: { input_tokens: 20, output_tokens: 3 },
      },
    }),
  )
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['thinking', 'tool', 'usage'],
  )
  assert.equal(lines[2].usage?.totalTokens, 23)
})

test('codex parser covers lifecycle, tool families and defensive event shapes', () => {
  assert.deepEqual(parseCodexEvent('not json'), [])
  assert.deepEqual(parseCodexEvent('{"type":"thread.started"}'), [{ kind: 'stage', text: '🚀 会话开始' }])
  assert.deepEqual(parseCodexEvent('{"type":"turn.started"}'), [{ kind: 'stage', text: '💭 开始一轮思考…' }])
  assert.deepEqual(parseCodexEvent('{"type":"turn.completed"}'), [{ kind: 'stage', text: '✅ 本轮完成' }])
  assert.deepEqual(parseCodexEvent('{"type":"unknown"}'), [])
  assert.deepEqual(parseCodexEvent('{"type":"item.completed"}'), [])

  const tools = [
    ['bash', '🔧 执行命令'],
    ['read_file', '📖 读取文件'],
    ['write_file', '✍️ 修改文件'],
    ['apply_patch', '🩹 应用补丁'],
    ['git_diff', '🌿 git'],
    ['gh', '🐙 gh'],
    ['WebSearch', '🔍 搜索'],
    ['WebFetch', '🌐 抓取网页'],
    ['task', '🤖 子代理'],
    ['AskUserQuestion', '❓ 提问'],
    ['custom', '🛠️ custom'],
  ]
  for (const [name, label] of tools) {
    const parsed = parseCodexEvent(
      JSON.stringify({ type: 'item.completed', item: { type: 'function_call', name, arguments: '  a\n b  ' } }),
    )
    assert.match(parsed[0].text, new RegExp(label))
  }
  assert.match(
    parseCodexEvent(
      JSON.stringify({ type: 'item.completed', item: { type: 'function_call', arguments: { path: 'src/a.ts' } } }),
    )[0].text,
    /tool.*path/,
  )
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.deepEqual(
    parseCodexEvent({
      toJSON: () => ({ type: 'item.completed', item: { type: 'function_call', arguments: circular } }),
    } as never),
    [],
  )
  assert.deepEqual(parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })), [])
  assert.deepEqual(
    parseCodexEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: '\nvalue\r\n\n' },
      }),
    ),
    [{ kind: 'command_output', text: 'value' }],
  )
  assert.deepEqual(parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } })), [])
  assert.deepEqual(parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'token_count' } })), [])
  assert.deepEqual(parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'error' } })), [
    { kind: 'text', text: '⚠️ error' },
  ])
})

test('claude parser covers system/result/default and partial content branches', () => {
  assert.deepEqual(parseClaudeEvent('not json'), [])
  assert.deepEqual(parseClaudeEvent('{"type":"assistant"}'), [])
  assert.deepEqual(
    parseClaudeEvent(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text' },
            { type: 'thinking', text: 'fallback thought' },
            { type: 'tool_use' },
            { type: 'tool_use', name: 'bash' },
            { type: 'ignored', text: 'skip' },
          ],
        },
      }),
    ).map((line) => line.kind),
    ['thinking', 'tool'],
  )
  assert.deepEqual(parseClaudeEvent(JSON.stringify({ type: 'system', message: { content: [] } })), [])
  assert.equal(
    parseClaudeEvent(JSON.stringify({ type: 'system', message: { content: [{ type: 'tool_use', name: 'Read' }] } }))[0]
      .kind,
    'tool',
  )
  assert.deepEqual(parseClaudeEvent('{"type":"result"}'), [{ kind: 'stage', text: '✅ 会话结束' }])
  assert.deepEqual(parseClaudeEvent('{"type":"unknown"}'), [])
  assert.deepEqual(parseAgentChunk('codex', '\nnot json\n{"type":"turn.started"}\n'), {
    lines: [{ kind: 'stage', text: '💭 开始一轮思考…' }],
    sessionId: null,
  })
})
