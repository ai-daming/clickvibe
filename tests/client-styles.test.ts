import assert from 'node:assert/strict'
import test from 'node:test'
import { measureStyleTokenCoverage, MINIMUM_STYLE_TOKEN_COVERAGE } from '../scripts/check-style-tokens.mjs'
import { PANEL_CSS } from '../src/client/styles.ts'

const DSH_THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-shadow-lv3',
  '--dsw-font-base-16-font-size',
  '--dsw-font-s-14-font-size',
  '--dsw-font-xs-13-font-size',
  '--dsw-font-xxs-12-font-size',
  '--dsw-font-xxxs-11-font-size',
])

function between(start: string, end: string): string {
  const startIndex = PANEL_CSS.indexOf(start)
  const endIndex = PANEL_CSS.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return PANEL_CSS.slice(startIndex, endIndex)
}

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(PANEL_CSS)
  assert.notEqual(match, null, `missing ${selector}`)
  return match?.[1] ?? ''
}

test('at least 80% of common color and font-size materials use theme tokens', () => {
  const coverage = measureStyleTokenCoverage(PANEL_CSS)
  assert.ok(
    coverage.ratio >= MINIMUM_STYLE_TOKEN_COVERAGE,
    `style token coverage ${(coverage.ratio * 100).toFixed(2)}% (${coverage.covered}/${coverage.total}) is below ${MINIMUM_STYLE_TOKEN_COVERAGE * 100}%`,
  )
})

test('panel common materials use only real DSH theme tokens', () => {
  const namedTokens = [...PANEL_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1] ?? '')
  assert.ok(namedTokens.length > 20, 'the panel must materially consume the DSH theme')
  assert.deepEqual(
    [...new Set(namedTokens)].filter((token) => !DSH_THEME_TOKENS.has(token)),
    [],
  )

  const semanticPalette = between('/* ClickVibe semantic palette: start */', '/* ClickVibe semantic palette: end */')
  const terminalPalette = between('/* Fixed dark terminal palette: start */', '/* Fixed dark terminal palette: end */')
  const commonCss = PANEL_CSS.replace(semanticPalette, '').replace(terminalPalette, '')
  assert.doesNotMatch(commonCss, /(?:#[0-9a-f]{3,8}\b|rgba?\()/i)
  assert.doesNotMatch(PANEL_CSS, /var\(--dsw-[a-z0-9-]+\s*,/)
})

test('only the minimal ClickVibe semantic palette follows the DSH body theme flag', () => {
  const palette = between('/* ClickVibe semantic palette: start */', '/* ClickVibe semantic palette: end */')
  assert.match(palette, /\.cv-panel-slot\s*\{[^}]*--cv-review-primary:[^}]*--cv-review-tertiary:/s)
  assert.match(
    palette,
    /body\[data-ds-dark-theme\]\s+\.cv-panel-slot\s*\{[^}]*--cv-review-primary:[^}]*--cv-review-tertiary:/s,
  )
  assert.doesNotMatch(PANEL_CSS, /prefers-color-scheme|MutationObserver|ui-theme\.preference/)
})

test('every text entry surface explicitly binds its background, text and placeholder to DSH', () => {
  for (const selector of ['.cv-input', '.cv-context-input']) {
    assert.match(declarations(selector), /background:\s*var\(--dsw-/)
    assert.match(declarations(selector), /color:\s*var\(--dsw-/)
    assert.match(declarations(`${selector}::placeholder`), /color:\s*var\(--dsw-/)
  }
})

test('terminal keeps an explicit fixed dark palette outside theme overrides', () => {
  const terminal = between('/* Fixed dark terminal palette: start */', '/* Fixed dark terminal palette: end */')
  assert.match(terminal, /\.cv-terminal\s*\{[^}]*background:\s*#0d1117;/s)
  assert.match(terminal, /\.cv-terminal-head \.cv-running-duration\s*\{[^}]*color:\s*inherit;[^}]*font:\s*inherit;/s)
  assert.match(terminal, /\.cv-terminal-head \.cv-running-dot\s*\{[^}]*background:\s*#3fb950;/s)
  assert.doesNotMatch(terminal, /var\(--dsw-/)
  assert.doesNotMatch(PANEL_CSS, /body\[data-ds-dark-theme\][^{]*\.cv-terminal/)
})

test('running duration owns one shared visual status marker', () => {
  assert.match(declarations('.cv-running-duration'), /display:\s*inline-flex;/)
  assert.match(declarations('.cv-running-duration'), /align-items:\s*center;/)
  assert.match(declarations('.cv-running-dot'), /background:\s*var\(--dsw-alias-state-success-primary\);/)
  assert.match(declarations('.cv-running-dot'), /border-radius:\s*50%;/)
})

test('terminal keeps long logical lines intact and exposes horizontal scrolling', () => {
  assert.match(declarations('.cv-dev-log'), /overflow:\s*auto;/)
  assert.match(declarations('.cv-dev-log'), /white-space:\s*pre;/)
  assert.match(declarations('.cv-dev-log'), /word-break:\s*normal;/)
  assert.match(declarations('.cv-dev-log'), /overflow-wrap:\s*normal;/)
  assert.match(declarations('.cv-terminal-line-number'), /user-select:\s*none;/)
})

test('expanded detail sections contain their own scroll chain and keep the toggle reachable', () => {
  assert.match(declarations('.cv-section-head'), /position:\s*sticky;/)
  assert.match(declarations('.cv-section-head'), /top:\s*0;/)
  assert.match(declarations('.cv-section-content'), /max-height:\s*min\(360px, 55vh\);/)
  assert.match(declarations('.cv-section-content'), /overflow:\s*auto;/)
  assert.match(declarations('.cv-section-content'), /overscroll-behavior:\s*contain;/)
})
