import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdownHtml } from '../src/client/markdown.ts'

const NL = String.fromCharCode(10)
const BQ = String.fromCharCode(96) // backtick, for inline-code assertions

// ---- tables (previously rendered as raw-pipe paragraph blobs) ----

test('renderMarkdownHtml renders GFM tables with header and rows', () => {
  const html = renderMarkdownHtml(
    ['| 配置项 | 取值 | 默认 |', '|---|---|---|', '| 自动合并 | 关 / 开 | 关 |', '| 总预算 | 小时 | 24 |'].join(NL),
  )
  assert.ok(html.includes('<table>'), html)
  assert.ok(html.includes('<th>配置项</th>'), html)
  assert.ok(html.includes('<td>自动合并</td>'), html)
  assert.ok(html.includes('<td>24</td>'), html)
  assert.ok(!html.includes('|配置项'), html)
})

test('renderMarkdownHtml renders unchecked and checked task list items', () => {
  const html = renderMarkdownHtml(['- [ ] 未完成', '- [x] 已完成'].join(NL))
  assert.ok(html.includes('type="checkbox"'), html)
  assert.ok(html.includes('checked'), html)
  assert.equal(html.match(/type="checkbox"/g)?.length, 2)
})

// ---- security hardening (output reaches the DOM via dangerouslySetInnerHTML) ----

test('renderMarkdownHtml escapes raw HTML instead of injecting it', () => {
  const html = renderMarkdownHtml('<script>alert(1)</script>')
  assert.ok(!html.includes('<script>'), html)
  assert.ok(html.includes('&lt;script&gt;'), html)
})

test('renderMarkdownHtml sinks javascript: links to a safe href', () => {
  const html = renderMarkdownHtml('[危险](javascript:alert(1))')
  assert.ok(html.includes('href="#"'), html)
  assert.ok(!html.includes('javascript:'), html)
})

test('renderMarkdownHtml keeps ordinary http links', () => {
  const html = renderMarkdownHtml('[链接](https://example.com/x)')
  assert.ok(html.includes('href="https://example.com/x"'), html)
})

// ---- preserved markdown essentials ----

test('renderMarkdownHtml renders headings, paragraphs, code and lists', () => {
  const html = renderMarkdownHtml(
    ['## 目标', '', '一段' + BQ + '代码' + BQ + ' 与 **加粗**', '', '- 甲', '- 乙'].join(NL),
  )
  assert.ok(html.includes('<h2>目标</h2>'), html)
  assert.ok(html.includes('<code>代码</code>'), html)
  assert.ok(html.includes('<strong>加粗</strong>'), html)
  assert.ok(html.includes('<li>甲</li>'), html)
})

test('renderMarkdownHtml keeps hard line breaks for multi-line paragraphs', () => {
  const html = renderMarkdownHtml(['第一行', '第二行'].join(NL))
  assert.ok(html.includes('第一行<br>'), html)
})

test('renderMarkdownHtml returns empty string for empty input', () => {
  assert.equal(renderMarkdownHtml(''), '')
})

// ---- acceptance-shaped document (the reported case) ----

test('renderMarkdownHtml renders the reported issue body shape correctly', () => {
  const md = [
    '## 目标',
    '自动推进直到 Review 通过.',
    '',
    '启动时可配置:',
    '',
    '| 配置项 | 取值 | 默认 |',
    '|---|---|---|',
    '| 自动合并 | 关 / 开 | 关 |',
    '',
    '验收标准',
    '- [ ] 列表与详情均有入口',
    '- [x] 门禁全过才合并',
  ].join(NL)
  const html = renderMarkdownHtml(md)
  assert.ok(html.includes('<h2>目标</h2>'), html)
  assert.ok(html.includes('<table>'), html)
  assert.ok(html.includes('<td>关 / 开</td>'), html)
  assert.equal(html.match(/type="checkbox"/g)?.length, 2)
  assert.ok(html.includes('列表与详情均有入口'), html)
})
