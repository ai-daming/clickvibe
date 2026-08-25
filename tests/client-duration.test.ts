import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeliveryDuration, RunningDuration, deliveryDurationLabel } from '../src/client/duration.ts'

test('delivery durations use a compact unit format', () => {
  assert.equal(deliveryDurationLabel(0), '0s')
  assert.equal(deliveryDurationLabel(754_000), '12m34s')
  assert.equal(deliveryDurationLabel(3_724_000), '1h02m')
})

test('running and delivery duration components render their display contracts', () => {
  const running = renderToStaticMarkup(React.createElement(RunningDuration, { startedAt: 1_000, now: 2_000 }))
  assert.match(running, /class="cv-running-dot" aria-hidden="true"/)
  assert.match(running, /正在运行 · 已运行 00:00:01/)
  assert.match(
    renderToStaticMarkup(React.createElement(DeliveryDuration, { kind: 'review', durationMs: 754_000 })),
    /耗时 12m34s/,
  )
  assert.equal(renderToStaticMarkup(React.createElement(DeliveryDuration, { kind: 'note', durationMs: 754_000 })), '')
})

test('one running-duration component serves detail, list and terminal header', () => {
  assert.match(
    renderToStaticMarkup(React.createElement(RunningDuration, { startedAt: 1_000, now: 2_000, compact: true })),
    /aria-label="正在运行，已运行 00:00:01"[^>]*>.*class="cv-running-dot" aria-hidden="true".*00:00:01</,
  )

  for (const path of [
    '../src/client/views/dev-section.tsx',
    '../src/client/views/project-panel.tsx',
    '../src/client/views/live-terminal.tsx',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /import \{ RunningDuration \} from '\.\.\/duration\.ts'/)
    assert.match(source, /<RunningDuration\b/)
  }

  const terminal = readFileSync(new URL('../src/client/views/live-terminal.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(terminal, /<span aria-hidden="true">●<\/span>/)
})
