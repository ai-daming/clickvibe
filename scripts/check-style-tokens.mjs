import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MINIMUM_STYLE_TOKEN_COVERAGE = 0.8

const EXCLUDED_SECTIONS = [
  ['/* ClickVibe semantic palette: start */', '/* ClickVibe semantic palette: end */'],
  ['/* Fixed dark terminal palette: start */', '/* Fixed dark terminal palette: end */'],
]

function removeMarkedSection(css, start, end) {
  const startIndex = css.indexOf(start)
  const endIndex = css.indexOf(end, startIndex + start.length)
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`missing style coverage marker: ${startIndex === -1 ? start : end}`)
  }
  return css.slice(0, startIndex) + css.slice(endIndex + end.length)
}

export function extractPanelCss(source) {
  const declaration = 'export const PANEL_CSS = `'
  const startIndex = source.indexOf(declaration)
  const endIndex = source.lastIndexOf('`')
  if (startIndex === -1 || endIndex <= startIndex) {
    throw new Error('could not extract PANEL_CSS template')
  }
  return source.slice(startIndex + declaration.length, endIndex)
}

export function measureStyleTokenCoverage(panelCss) {
  const commonCss = EXCLUDED_SECTIONS.reduce((css, [start, end]) => removeMarkedSection(css, start, end), panelCss)
  const declarations = [...commonCss.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)]
    .map((match) => ({ property: match[1] ?? '', value: match[2] ?? '' }))
    .filter(({ property }) => !property.startsWith('--'))
  const token = /var\(--(?:dsw|cv)-/
  const colorLiteral = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/i
  const fontSizeLiteral = /\d+(?:\.\d+)?px/i
  const relevant = declarations.filter(({ property, value }) => {
    const isFontSize = property === 'font-size' && (token.test(value) || fontSizeLiteral.test(value))
    const isColorMaterial =
      /(?:color|background|border|outline|shadow)/.test(property) && (token.test(value) || colorLiteral.test(value))
    return isFontSize || isColorMaterial
  })
  const covered = relevant.filter(({ value }) => token.test(value)).length
  const total = relevant.length
  return { covered, total, ratio: total === 0 ? 0 : covered / total }
}

function run() {
  const stylesPath = path.resolve(process.argv[2] ?? 'src/client/styles.ts')
  const css = extractPanelCss(fs.readFileSync(stylesPath, 'utf8'))
  const coverage = measureStyleTokenCoverage(css)
  const percent = (coverage.ratio * 100).toFixed(2)
  console.log(`style token coverage: ${percent}% (${coverage.covered}/${coverage.total})`)
  if (coverage.ratio < MINIMUM_STYLE_TOKEN_COVERAGE) {
    console.error(`required style token coverage: ${MINIMUM_STYLE_TOKEN_COVERAGE * 100}%`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) run()
