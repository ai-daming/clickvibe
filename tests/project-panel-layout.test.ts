import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PANEL_CSS } from '../src/client/styles.ts'

test('running duration stays inside the issue row content column', () => {
  const source = readFileSync(new URL('../src/client/views/project-panel.tsx', import.meta.url), 'utf8')

  assert.match(
    source,
    /<div className="cv-issue-row-main">[\s\S]*?<RunningDuration startedAt=\{issue\.workflow\.runStartedAt\} \/>[\s\S]*?<div className="cv-issue-row-meta">/,
  )
})

test('issue rows keep four grid columns and reserve the last one for the action', () => {
  assert.match(PANEL_CSS, /\.cv-issue-row \{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto;/)
  assert.match(PANEL_CSS, /\.cv-row-action \{[^}]*white-space:\s*nowrap;/)
})
