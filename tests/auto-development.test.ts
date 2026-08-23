import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DependencyLedgerRetryGate,
  buildDependencyUnlockComment,
  dependencyUnlockMarker,
  deriveAutoDevelopment,
  isFirstDevelopment,
  rewriteCompletedDependencySection,
} from '../src/workflow/auto-development.ts'
import { checkIssueContract } from '../src/workflow/issue-contract.ts'
import { parseDependencies } from '../src/agent/develop.ts'

const contract = { ok: true, missing: [] }

test('auto development is ready only for a valid first development with closed dependencies', () => {
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract, firstDevelopment: true }).status, 'ready')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['CLOSED'], contract, firstDevelopment: true }).status, 'ready')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['OPEN'], contract, firstDevelopment: true }).status, 'blocked')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['UNKNOWN'], contract, firstDevelopment: true }).status, 'dependency-unknown')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract: { ok: false, missing: ['验收标准'] }, firstDevelopment: true }).status, 'invalid-contract')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract, firstDevelopment: false }).status, 'not-startable')
})

test('first development excludes every positive development-history fact', () => {
  const clean = {
    workflowHasDevelopmentHistory: false,
    hasCommits: false,
    hasUncommittedChanges: false,
    hasPr: false,
    worktreeNeedsRepair: false,
  }
  assert.equal(isFirstDevelopment(clean), true)
  for (const key of Object.keys(clean) as Array<keyof typeof clean>) {
    assert.equal(isFirstDevelopment({ ...clean, [key]: true }), false, key)
  }
})

test('dependency unlock ledger is stable, traceable and no longer parsed as an edge', () => {
  const body = `## 目标\n做事\n\n## 验收标准\n- [ ] 完成\n\n## 依赖\nBlocked by #8, #3\n\n## 参考\n#4`
  const updated = rewriteCompletedDependencySection(body, [8, 3, 8])
  assert.match(updated, /依赖: 无\(原 Blocked by #3、#8 已完成，自动更新\)/)
  assert.deepEqual(parseDependencies(updated), [])
  assert.equal(checkIssueContract(updated).ok, true)
  assert.equal(dependencyUnlockMarker([8, 3, 8]), '<!-- clickvibe:dependency-unlock:3,8 -->')
  const comment = buildDependencyUnlockComment({ issueNumber: 9, dependencyNumbers: [8, 3], at: '2026-08-22T00:00:00Z' })
  assert.match(comment, /^== Dependency Meta ==\n- event: dependency-unlock\n- issue: #9/m)
  assert.match(comment, /依赖 #3、#8 已完成，本 issue 解锁/)
})

test('an explicit dependency after the automatic no-dependency history remains active', () => {
  const body = `## 依赖\n\n依赖: 无(原 Blocked by #8 已完成，自动更新)\nBlocked by #12\n\n## 参考\n#4`
  assert.deepEqual(parseDependencies(body), [12])
})

test('dependency rewrite preserves a following compact level-two heading', () => {
  const body = `##目标\n做事\n\n##依赖\nBlocked by #8\n\n##参考\n不能删除`
  const updated = rewriteCompletedDependencySection(body, [8])
  assert.match(updated, /##参考\n不能删除$/)
})

test('dependency ledger retry gate applies bounded exponential cooldown', () => {
  let now = 1_000
  const gate = new DependencyLedgerRetryGate({ baseMs: 100, maxMs: 400, now: () => now })
  assert.equal(gate.blocked('o/r#9'), null)
  assert.equal(gate.fail('o/r#9', 'offline').retryAt, 1_100)
  assert.match(gate.blocked('o/r#9')?.error ?? '', /offline/)
  now = 1_100
  assert.equal(gate.blocked('o/r#9'), null)
  assert.equal(gate.fail('o/r#9', 'still offline').retryAt, 1_300)
  now = 1_300
  assert.equal(gate.fail('o/r#9', 'again').retryAt, 1_700)
  gate.succeed('o/r#9')
  assert.equal(gate.blocked('o/r#9'), null)
})
