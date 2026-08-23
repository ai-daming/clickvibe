import assert from 'node:assert/strict'
import test from 'node:test'
import { ISSUE_ORGANIZER_PROMPT, submitIssueOrganization } from '../src/client/issue-organizer.ts'

test('issue organizer prompt preserves the governed preview-first workflow', () => {
  assert.match(ISSUE_ORGANIZER_PROMPT, /先复述本次讨论已经形成的结论/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /刷新 GitHub 现状/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /## 目标/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /## 验收标准/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /## 依赖/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /精确预览/)
  assert.match(ISSUE_ORGANIZER_PROMPT, /逐项明确授权/)
  assert.doesNotMatch(ISSUE_ORGANIZER_PROMPT, /ClickVibe 契约/)
})

test('issue organizer sends through the composer draft and submit path', () => {
  const calls: string[] = []
  submitIssueOrganization({
    setDraft(text) {
      calls.push(`draft:${text}`)
    },
    submit() {
      calls.push('submit')
    },
  })

  assert.deepEqual(calls, [`draft:${ISSUE_ORGANIZER_PROMPT}`, 'submit'])
})
