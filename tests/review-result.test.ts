import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseAgentChunk, type AgentKind } from '../src/agent-stream.ts'
import {
  clearReviewResultFile,
  loadReviewResult,
  REVIEW_RESULT_RELATIVE_PATH,
} from '../src/review-result.ts'

function agentOutput(agent: AgentKind, text: string): string {
  return agent === 'codex'
    ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })
    : JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

async function withWorktree(run: (worktree: string) => Promise<void>): Promise<void> {
  const worktree = await mkdtemp(join(tmpdir(), 'clickvibe-review-result-'))
  try {
    await run(worktree)
  } finally {
    await rm(worktree, { recursive: true, force: true })
  }
}

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent}: materialized JSON wins even when the displayed conclusion is truncated`, async () => {
    await withWorktree(async (worktree) => {
      const issues = Array.from({ length: 12 }, (_, index) => `问题 ${index + 1}: ${'长描述'.repeat(220)}`)
      await mkdir(join(worktree, '.clickvibe'))
      await writeFile(
        join(worktree, REVIEW_RESULT_RELATIVE_PATH),
        JSON.stringify({ passed: false, issues }),
      )
      const parsed = parseAgentChunk(agent, agentOutput(agent, `${'分析'.repeat(2500)}${JSON.stringify({ passed: true, issues: [] })}`))
      assert.match(parsed.lines[0].text, /…$/)

      const resolved = await loadReviewResult(worktree, parsed.lines.map((line) => line.text))
      assert.equal(resolved.source, 'file')
      assert.deepEqual(resolved.result, { passed: false, issues })
    })
  })

  test(`${agent}: stdout JSON remains the first fallback`, async () => {
    await withWorktree(async (worktree) => {
      const expected = { passed: false, issues: ['src/a.ts:10 存在竞态'] }
      const parsed = parseAgentChunk(agent, agentOutput(agent, JSON.stringify(expected)))
      const resolved = await loadReviewResult(worktree, parsed.lines.map((line) => line.text))
      assert.equal(resolved.source, 'stdout-json')
      assert.match(resolved.fileError ?? '', /不存在/)
      assert.deepEqual(resolved.result, expected)
    })
  })

  test(`${agent}: emoji verdict remains the final fallback`, async () => {
    await withWorktree(async (worktree) => {
      const parsed = parseAgentChunk(agent, agentOutput(agent, '✅ Review 通过'))
      const resolved = await loadReviewResult(worktree, parsed.lines.map((line) => line.text))
      assert.equal(resolved.source, 'stdout-verdict')
      assert.deepEqual(resolved.result, { passed: true, issues: [] })
    })
  })
}

test('invalid materialized JSON logs a reason and falls back without accepting a partial schema', async () => {
  await withWorktree(async (worktree) => {
    await mkdir(join(worktree, '.clickvibe'))
    await writeFile(join(worktree, REVIEW_RESULT_RELATIVE_PATH), '{"passed":false,"issues":[1]}')
    const resolved = await loadReviewResult(worktree, ['💬 {"passed":true,"issues":[]}'])
    assert.equal(resolved.source, 'stdout-json')
    assert.match(resolved.fileError ?? '', /issues/)
    assert.deepEqual(resolved.result, { passed: true, issues: [] })
  })
})

test('a passing materialized verdict cannot carry contradictory issues', async () => {
  await withWorktree(async (worktree) => {
    await mkdir(join(worktree, '.clickvibe'))
    await writeFile(join(worktree, REVIEW_RESULT_RELATIVE_PATH), '{"passed":true,"issues":["still broken"]}')
    const resolved = await loadReviewResult(worktree, ['💬 ❌ Review 发现问题'])
    assert.equal(resolved.source, 'stdout-verdict')
    assert.match(resolved.fileError ?? '', /schema/)
    assert.deepEqual(resolved.result, { passed: false, issues: [] })
  })
})

test('clearing the materialized result prevents a stale review from being reused', async () => {
  await withWorktree(async (worktree) => {
    await mkdir(join(worktree, '.clickvibe'))
    const path = join(worktree, REVIEW_RESULT_RELATIVE_PATH)
    await writeFile(path, '{"passed":true,"issues":[]}')
    await clearReviewResultFile(worktree)
    const resolved = await loadReviewResult(worktree, ['💬 ❌ Review 发现问题'])
    assert.equal(resolved.source, 'stdout-verdict')
    assert.deepEqual(resolved.result, { passed: false, issues: [] })
  })
})
