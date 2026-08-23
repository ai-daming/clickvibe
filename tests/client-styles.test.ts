import assert from 'node:assert/strict'
import test from 'node:test'
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
])

function between(start: string, end: string): string {
  const startIndex = PANEL_CSS.indexOf(start)
  const endIndex = PANEL_CSS.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing ${start}`)
  assert.notEqual(endIndex, -1, `missing ${end}`)
  return PANEL_CSS.slice(startIndex, endIndex)
}

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

test('terminal keeps an explicit fixed dark palette outside theme overrides', () => {
  const terminal = between('/* Fixed dark terminal palette: start */', '/* Fixed dark terminal palette: end */')
  assert.match(terminal, /\.cv-terminal\s*\{[^}]*background:\s*#0d1117;/s)
  assert.doesNotMatch(terminal, /var\(--dsw-/)
  assert.doesNotMatch(PANEL_CSS, /body\[data-ds-dark-theme\][^{]*\.cv-terminal/)
})
