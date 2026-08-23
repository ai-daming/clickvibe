import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueRowMeta } from '../src/client/views/issue-row-meta.ts'

test('issue row meta renders label/value pairs in primary and signal layers', () => {
  const html = renderToStaticMarkup(
    React.createElement(IssueRowMeta, {
      branch: 'clickvibe-issue-84-with-a-long-name',
      milestone: 'UI polish milestone',
      blockedBy: [
        { number: 12, state: 'OPEN' },
        { number: 9, state: 'CLOSED' },
      ],
      behindBase: 3,
      contract: { ok: false, missing: ['验收标准', '依赖'] },
      autoDevelopmentReady: true,
      dependencyLedger: { updated: true },
    }),
  )

  assert.match(html, /class="cv-issue-row-meta"/)
  assert.match(html, /class="cv-row-meta-layer cv-row-meta-primary"/)
  assert.match(html, /class="cv-row-meta-label">分支<\/span><span class="cv-row-meta-value"/)
  assert.match(html, /title="clickvibe-issue-84-with-a-long-name"/)
  assert.match(html, /class="cv-row-meta-item cv-row-meta-secondary"/)
  assert.match(html, /class="cv-row-meta-label">blockedBy<\/span>/)
  assert.match(html, /#12⏳ #9✓/)
  assert.match(html, /class="cv-row-meta-layer cv-row-meta-signals"/)
  assert.match(html, /class="cv-row-meta-item cv-row-lag"[^>]*>.*落后.*3/s)
  assert.match(html, /class="cv-row-meta-item cv-row-contract"[^>]*>.*不满足契约/s)
  assert.match(html, /ready · 可自动下单/)
  assert.match(html, /依赖账本<\/span><span class="cv-row-meta-value" title="已自动更新">已自动更新<\/span>/)
})

test('issue row meta keeps empty values explicit without rendering an empty signal layer', () => {
  const html = renderToStaticMarkup(
    React.createElement(IssueRowMeta, {
      branch: null,
      milestone: null,
      blockedBy: [],
      behindBase: 0,
      contract: { ok: true, missing: [] },
      autoDevelopmentReady: false,
      dependencyLedger: undefined,
    }),
  )

  assert.match(html, /分支<\/span><span class="cv-row-meta-value" title="无">无<\/span>/)
  assert.match(html, /里程碑<\/span><span class="cv-row-meta-value" title="无">无<\/span>/)
  assert.match(html, /blockedBy<\/span><span class="cv-row-meta-value" title="无">无<\/span>/)
  assert.doesNotMatch(html, /cv-row-meta-signals/)
})
