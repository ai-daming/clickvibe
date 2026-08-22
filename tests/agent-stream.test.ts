import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentChunk, parseClaudeEvent, parseCodexEvent } from '../src/agent-stream.ts'

const longMessage = 'x'.repeat(5000)

test('codex and claude use the same 4000-character display limit for messages', () => {
  const codex = parseCodexEvent(JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: longMessage },
  }))
  const claude = parseClaudeEvent(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: longMessage }] },
  }))
  assert.equal(codex[0].text, claude[0].text)
  assert.equal(codex[0].text, `💬 ${'x'.repeat(4000)}…`)
})

test('agent streams expose session ids before completion', () => {
  assert.equal(parseAgentChunk('codex', JSON.stringify({
    type: 'thread.started', thread_id: 'thread-123',
  })).sessionId, 'thread-123')
  assert.equal(parseAgentChunk('claude', JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'session-123',
  })).sessionId, 'session-123')
})
