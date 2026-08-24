import assert from 'node:assert/strict'
import test from 'node:test'
import {
  lossyAgentOutputNotice,
  parseAgentChunk,
  parseClaudeEvent,
  parseCodexEvent,
} from '../src/agent/agent-stream.ts'

const longMessage = `/Users/example/project\n  ${'x'.repeat(5000)}\n/tmp/clickvibe-worktree`

test('codex and claude preserve complete messages with whitespace unchanged', () => {
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
  assert.equal(codex[0].text, `💬 ${longMessage}`)
})

test('codex preserves complete reasoning, commands, errors and tool arguments', () => {
  const reasoning = `inspect\n  ${'r'.repeat(5000)}`
  const command = `cd /Users/example/project\n${'c'.repeat(1200)}`
  const error = `failed\n  ${'e'.repeat(300)}`
  const toolArguments = `/tmp/clickvibe\n  ${'a'.repeat(300)}`

  assert.equal(
    parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: reasoning } }))[0].text,
    `◌ ${reasoning}`,
  )
  assert.equal(
    parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } }))[0].text,
    `$ ${command}`,
  )
  assert.equal(
    parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'error', text: error } }))[0].text,
    `⚠️ ${error}`,
  )
  assert.equal(
    parseCodexEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'function_call', name: 'shell', arguments: toolArguments },
      }),
    )[0].text,
    `🔧 执行命令: ${toolArguments}`,
  )
})

test('codex error items without useful text identify the reporting agent', () => {
  for (const text of [undefined, '', '   ']) {
    assert.deepEqual(parseCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'error', text } })), [
      { kind: 'text', text: '⚠️ Codex 报告错误，但未提供错误详情' },
    ])
  }
})

test('lossy agent output notice explains the host buffer gap and spill recovery paths', () => {
  assert.equal(
    lossyAgentOutputNotice({
      lossy: true,
      stdoutSpillPath: '/private/tmp/dsh/stdout.log',
      stderrSpillPath: '/private/tmp/dsh/stderr.log',
    }),
    '[clickvibe] 宿主流式缓冲已丢失部分 Agent 输出；可从宿主 spill 文件恢复：stdout /private/tmp/dsh/stdout.log；stderr /private/tmp/dsh/stderr.log',
  )
  assert.equal(
    lossyAgentOutputNotice({ lossy: true }),
    '[clickvibe] 宿主流式缓冲已丢失部分 Agent 输出；宿主未提供 spill 文件，缺口无法从 ClickVibe 日志恢复',
  )
  assert.equal(lossyAgentOutputNotice({ lossy: false }), null)
})

test('codex preserves command output whitespace as one complete event', () => {
  const output = 'first line\n\n  indented with trailing spaces  \nlast line\n'
  assert.deepEqual(
    parseCodexEvent(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: output },
      }),
    ),
    [{ kind: 'command_output', text: output }],
  )
})

test('claude preserves complete thinking and tool arguments', () => {
  const thinking = `inspect\n  ${'t'.repeat(5000)}`
  const input = { command: `cd /Users/example/project\n${'z'.repeat(300)}`, workdir: '/tmp/clickvibe' }
  const lines = parseClaudeEvent(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking },
          { type: 'tool_use', name: 'bash', input },
        ],
      },
    }),
  )

  assert.equal(lines[0].text, `◌ ${thinking}`)
  assert.equal(lines[1].text, `🔧 执行命令: ${JSON.stringify(input)}`)
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
      { kind: 'command_output', text: 'one\ntwo\n' },
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
