import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PANEL_CSS } from '../src/client/styles.ts'

test('running duration stays inside the issue row content column', () => {
  const source = readFileSync(new URL('../src/client/views/project-panel.tsx', import.meta.url), 'utf8')

  assert.match(
    source,
    /<div className="cv-issue-row-main">[\s\S]*?<RunningDuration startedAt=\{issue\.workflow\.runStartedAt\} \/>[\s\S]*?<IssueRowMeta/,
  )
  assert.match(source, /className="cv-issue-row-title"[\s\S]*?title=\{`#\$\{issue\.number\} \$\{issue\.title\}`\}/)
})

test('issue rows keep four grid columns and reserve the last one for the action', () => {
  assert.match(PANEL_CSS, /\.cv-issue-row \{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto;/)
  assert.match(PANEL_CSS, /\.cv-row-action \{[^}]*white-space:\s*nowrap;/)
  assert.match(PANEL_CSS, /\.cv-row-actions \{[^}]*display:\s*flex;[^}]*white-space:\s*nowrap;/)
})

test('issue row text truncates by priority and omits only secondary meta in narrow content columns', () => {
  assert.match(PANEL_CSS, /\.cv-issue-row-main \{[^}]*min-width:\s*0;[^}]*container-type:\s*inline-size;/)
  assert.match(
    PANEL_CSS,
    /\.cv-issue-row-title \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
  )
  assert.match(PANEL_CSS, /\.cv-row-meta-value \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/)
  assert.match(
    PANEL_CSS,
    /:is\(\.cv-row-lag, \.cv-row-contract, \.cv-row-ready\) \.cv-row-meta-value \{ color:\s*inherit; \}/,
  )
  assert.match(PANEL_CSS, /\.cv-row-meta-item \+ \.cv-row-meta-item::before \{[^}]*content:\s*'·';/)
  assert.match(PANEL_CSS, /\.cv-row-meta-primary \.cv-row-meta-item:nth-child\(2\) \{ flex:\s*none; \}/)
  assert.match(
    PANEL_CSS,
    /\.cv-row-meta-signals \{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 150px\), 1fr\)\);/,
  )
  assert.match(PANEL_CSS, /\.cv-row-meta-signals \.cv-row-meta-item::before \{ content:\s*none; \}/)
  assert.match(PANEL_CSS, /@container \(max-width:\s*240px\) \{ \.cv-row-meta-secondary \{ display:\s*none; \} \}/)
})
