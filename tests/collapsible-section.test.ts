import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CollapsibleSection,
  readSectionExpanded,
  writeSectionExpanded,
} from '../src/client/views/collapsible-section.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage unavailable')
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded')
    this.values.set(key, value)
  }
}

test('section state persists booleans and safely falls back when storage is unavailable or invalid', () => {
  const storage = new MemoryStorage()
  assert.equal(readSectionExpanded(storage, 'dependency', true), true)
  assert.equal(readSectionExpanded(storage, 'timeline', false), false)

  writeSectionExpanded(storage, 'dependency', false)
  assert.equal(storage.values.get('dependency'), 'false')
  assert.equal(readSectionExpanded(storage, 'dependency', true), false)

  storage.values.set('dependency', 'invalid')
  assert.equal(readSectionExpanded(storage, 'dependency', true), true)
  storage.failReads = true
  assert.equal(readSectionExpanded(storage, 'dependency', false), false)
  storage.failWrites = true
  assert.doesNotThrow(() => writeSectionExpanded(storage, 'dependency', true))
})

test('collapsible section exposes its state and omits collapsed content', () => {
  const expanded = renderToStaticMarkup(
    React.createElement(
      CollapsibleSection,
      { storageKey: 'issue:85:dependencies', title: '依赖图', defaultExpanded: true },
      React.createElement('span', null, 'dependency content'),
    ),
  )
  assert.match(expanded, /aria-expanded="true"/)
  assert.match(expanded, /依赖图/)
  assert.match(expanded, /dependency content/)

  const collapsed = renderToStaticMarkup(
    React.createElement(
      CollapsibleSection,
      { storageKey: 'issue:85:timeline', title: '时间线', defaultExpanded: false },
      React.createElement('span', null, 'timeline content'),
    ),
  )
  assert.match(collapsed, /aria-expanded="false"/)
  assert.doesNotMatch(collapsed, /timeline content/)
})

test('issue detail gives every long information block an issue-scoped persisted section', () => {
  const issueView = readFileSync(new URL('../src/client/views/issue-view.tsx', import.meta.url), 'utf8')
  const deliveryTimeline = readFileSync(new URL('../src/client/views/delivery-timeline.tsx', import.meta.url), 'utf8')

  assert.match(issueView, /sectionStorageKey\(issue\.url, 'dependencies'\)/)
  assert.match(issueView, /title="依赖图"[\s\S]*defaultExpanded/)
  assert.match(issueView, /sectionStorageKey\(issue\.url, 'github-timeline'\)/)
  assert.match(issueView, /title="时间线"[\s\S]*defaultExpanded=\{false\}/)
  assert.match(deliveryTimeline, /storageKey=\{sectionStorageKey\}/)
  assert.match(deliveryTimeline, /title="交付流水"[\s\S]*defaultExpanded/)
})
