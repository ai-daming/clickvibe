import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DeliveryDuration,
  RunningDuration,
  deliveryDurationLabel,
  runningDurationLabel,
} from '../src/client/duration.ts'

test('running counters always use HH:MM:SS and clamp clock skew to zero', () => {
  assert.equal(runningDurationLabel(-1), '00:00:00')
  assert.equal(runningDurationLabel(1_000), '00:00:01')
  assert.equal(runningDurationLabel(3_724_000), '01:02:04')
})

test('delivery durations use a compact unit format', () => {
  assert.equal(deliveryDurationLabel(0), '0s')
  assert.equal(deliveryDurationLabel(754_000), '12m34s')
  assert.equal(deliveryDurationLabel(3_724_000), '1h02m')
})

test('running and delivery duration components render their display contracts', () => {
  assert.match(
    renderToStaticMarkup(React.createElement(RunningDuration, { startedAt: 1_000, now: 2_000 })),
    /正在运行 · 已运行 00:00:01/,
  )
  assert.match(
    renderToStaticMarkup(React.createElement(DeliveryDuration, { kind: 'review', durationMs: 754_000 })),
    /耗时 12m34s/,
  )
  assert.equal(renderToStaticMarkup(React.createElement(DeliveryDuration, { kind: 'note', durationMs: 754_000 })), '')
})
