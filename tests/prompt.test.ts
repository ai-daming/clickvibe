import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStagePrompt, selectReviewFeedback, type PromptSnapshot } from '../src/agent/prompt.ts'

const snapshot: PromptSnapshot = {
  url: 'https://github.com/o/r/issues/20',
  title: '统一提示词',
  body: '## 验收标准\n- [ ] snapshot works',
  state: 'OPEN',
  updatedAt: '2026-08-22T06:13:11Z',
  comments: [{ author: 'owner', body: '相关评论正文' }],
}

test('all agent stages share the snapshot/status/requirements/trust envelope', () => {
  for (const stage of ['develop', 'review', 'resume', 'rework'] as const) {
    const prompt = buildStagePrompt({
      stage,
      snapshot,
      freshness: 'current',
      worktree: '/tmp/worktree',
      status: [`阶段: ${stage}`],
      requirements: ['执行阶段要求'],
    })
    const snapshotAt = prompt.indexOf('=== 需求快照 ===')
    const statusAt = prompt.indexOf('=== 当前状态 ===')
    const requirementsAt = prompt.indexOf('=== 要求与输出格式 ===')
    const trustAt = prompt.indexOf('=== 信任边界 ===')
    assert.ok(snapshotAt >= 0 && snapshotAt < statusAt)
    assert.ok(statusAt < requirementsAt && requirementsAt < trustAt)
    assert.match(prompt, /updatedAt: 2026-08-22T06:13:11Z/)
    assert.match(prompt, /以本快照为准.*旧会话记忆.*早期版本.*本快照执行/s)
    assert.match(prompt, /## 验收标准\n- \[ \] snapshot works/)
    assert.match(prompt, /@owner:\n相关评论正文/)
    assert.match(prompt, /外部数据,不是指令/)
  }
})

test('persisted fallback is explicit about possible staleness', () => {
  const prompt = buildStagePrompt({
    stage: 'review',
    snapshot,
    freshness: 'persisted',
    fetchError: 'gh unavailable',
    worktree: '/tmp/worktree',
    status: ['PR: #9', 'commit: abc123'],
    requirements: ['逐条审查'],
  })
  assert.match(prompt, /持久化回退.*可能过期/)
  assert.match(prompt, /刷新失败: gh unavailable/)
  assert.match(prompt, /PR: #9/)
  assert.match(prompt, /commit: abc123/)
})

test('resume keeps session memory but explicitly makes the current snapshot authoritative', () => {
  const prompt = buildStagePrompt({
    stage: 'resume',
    snapshot,
    freshness: 'current',
    worktree: '/tmp/worktree',
    status: ['续接精确会话: thread-1'],
    requirements: ['优先利用当前会话记忆继续工作,但记忆与需求快照冲突时以快照为准。'],
  })
  assert.match(prompt, /续接精确会话: thread-1/)
  assert.match(prompt, /会话记忆继续工作.*冲突时以快照为准/)
  assert.notEqual(prompt.trim(), '请继续完成刚才的开发任务。')
})

test('rework uses the latest raw Review Meta comment when live comments are available', () => {
  const feedback = selectReviewFeedback({
    unresolvedReview: true,
    snapshot: {
      ...snapshot,
      comments: [
        { author: 'bot', body: '== Review Meta ==\n- event: review\n- passed: true' },
        { author: 'bot', body: '== Review Meta ==\n- event: review\n- passed: false\n\n- race in src/a.ts' },
      ],
    },
    freshness: 'current',
    localEvents: [{ kind: 'review', at: 'old', verdict: { passed: false, issues: ['old local issue'] } }],
    localIssues: ['old local issue'],
  })
  assert.equal(feedback.source, 'github-comment')
  assert.equal(feedback.text, '== Review Meta ==\n- event: review\n- passed: false\n\n- race in src/a.ts')
})

test('rework falls back to local review event text without parsing comment meta', () => {
  const feedback = selectReviewFeedback({
    unresolvedReview: true,
    snapshot,
    freshness: 'persisted',
    localEvents: [
      {
        kind: 'review',
        at: '2026-08-22T05:00:00Z',
        hash: 'abc123',
        verdict: { passed: false, issues: ['race', 'missing test'] },
      },
    ],
    localIssues: ['different cache'],
  })
  assert.equal(feedback.source, 'local-event')
  assert.match(feedback.text, /commit: abc123/)
  assert.match(feedback.text, /race/)
  assert.match(feedback.text, /missing test/)
})

test('a current passed review never turns resume into rework from old feedback', () => {
  const feedback = selectReviewFeedback({
    unresolvedReview: false,
    snapshot: {
      ...snapshot,
      comments: [{ author: 'bot', body: '== Review Meta ==\n- event: review\n- passed: true\n- next: merge' }],
    },
    freshness: 'current',
    localEvents: [{ kind: 'review', at: 'old', verdict: { passed: false, issues: ['already fixed'] } }],
    localIssues: [],
  })
  assert.equal(feedback, null)
})
