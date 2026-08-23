import assert from 'node:assert/strict'
import test from 'node:test'
import { checkIssueContract } from '../src/workflow/issue-contract.ts'

const GOOD = `## 目标

一键开发功能完善。

## 验收标准

- [ ] dry-run 模式可用
- [ ] 自举验证通过

## 依赖

无
`

test('complete contract passes', () => {
  const result = checkIssueContract(GOOD)
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('accepts Blocked by #NN dependency form', () => {
  const body = GOOD.replace(/^无$/m, 'Blocked by #7')
  const result = checkIssueContract(body)
  assert.equal(result.ok, true)
})

test('missing 目标 is reported', () => {
  const body = GOOD.replace(/## 目标\n\n[^#]+/, '')
  const result = checkIssueContract(body)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['目标'])
})

test('missing 验收标准 is reported even when 依赖 present', () => {
  const body = GOOD.replace(/## 验收标准\n\n- \[ \] [^#]+/, '')
  const result = checkIssueContract(body)
  assert.equal(result.ok, false)
  assert.ok(result.missing.includes('验收标准'))
})

test('验收标准 without a - [ ] checklist item is rejected', () => {
  const body = GOOD.replace(/- \[ \] dry-run 模式可用\n- \[ \] 自举验证通过/, '文字描述验收,无 checklist')
  const result = checkIssueContract(body)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['验收标准'])
})

test('missing 依赖 is reported', () => {
  const body = GOOD.replace(/## 依赖\n\n无/, '')
  const result = checkIssueContract(body)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['依赖'])
})

test('依赖 section with garbage text is not accepted', () => {
  const body = GOOD.replace(/^无$/m, '等 #7 做完')
  const result = checkIssueContract(body)
  assert.equal(result.ok, false)
  assert.ok(result.missing.includes('依赖'))
})

test('empty body reports all three required sections', () => {
  const result = checkIssueContract('')
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['目标', '验收标准', '依赖'])
})

test('checked checklist items count as acceptance criteria', () => {
  const body = GOOD.replace(/- \[ \] dry-run 模式可用/, '- [x] dry-run 模式可用')
  const result = checkIssueContract(body)
  assert.equal(result.ok, true)
})

test('section parse stops at the next heading, not the document end', () => {
  const body = `## 目标

做 A。

## 验收标准

- [ ] A 完成

总结一句不属于任何节。

## 依赖

无
`
  const result = checkIssueContract(body)
  assert.equal(result.ok, true)
})
