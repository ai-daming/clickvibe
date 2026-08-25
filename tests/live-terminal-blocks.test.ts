import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LogBlocks } from '../src/client/log-block-view.ts'
import type { LiveLogEvent } from '../src/client/runtime.ts'

function render(events: LiveLogEvent[]): string {
  return renderToStaticMarkup(React.createElement(LogBlocks, { events, taskId: null }))
}

test('terminal defaults a long command-output block to its preview with a line-count toggle', () => {
  const text = Array.from({ length: 21 }, (_, index) => `output ${index + 1}`).join('\n')
  const html = render([{ source: 'agent', kind: 'command_output', text }])

  assert.match(html, />展开 21 行</)
  assert.match(html, /output 1/)
  assert.doesNotMatch(html, /output 9/)
  assert.match(html, /cv-terminal-block-text/)
})

test('terminal keeps short system, stage, command and message events directly visible while hiding usage', () => {
  const html = render([
    { source: 'system', kind: 'system', text: '[clickvibe] ready' },
    { source: 'agent', kind: 'stage', text: 'planning' },
    { source: 'agent', kind: 'command', text: '$ pnpm test' },
    { source: 'agent', kind: 'message', text: 'done' },
    { source: 'agent', kind: 'usage', text: 'hidden usage', usage: { totalTokens: 10 } },
  ])

  assert.match(html, /\[clickvibe\] ready/)
  assert.match(html, /planning/)
  assert.match(html, /\$ pnpm test/)
  assert.match(html, /done/)
  assert.doesNotMatch(html, /hidden usage/)
  assert.doesNotMatch(html, />展开/)
})

test('terminal numbers logical lines continuously while collapsed blocks reserve hidden locations', () => {
  const longOutput = Array.from({ length: 21 }, (_, index) => `output ${index + 1}`).join('\n')
  const html = render([
    { source: 'agent', kind: 'message', text: 'first\nsecond' },
    { source: 'agent', kind: 'command_output', text: longOutput },
    { source: 'agent', kind: 'message', text: 'after collapsed output' },
  ])

  assert.match(html, /cv-terminal-line-number[^>]*>1</)
  assert.match(html, /cv-terminal-line-number[^>]*>2</)
  assert.match(html, /cv-terminal-line-number[^>]*>3</)
  assert.match(html, /cv-terminal-line-number[^>]*>24</)
  assert.doesNotMatch(html, /cv-terminal-line-number[^>]*>11</)
})
