import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDependencyUnlockComment,
  dependencyUnlockMarker,
  deriveAutoDevelopment,
  rewriteCompletedDependencySection,
} from '../src/auto-development.ts'
import { checkIssueContract } from '../src/issue-contract.ts'
import { parseDependencies } from '../src/develop.ts'

const contract = { ok: true, missing: [] }

test('auto development is ready only for a valid first development with closed dependencies', () => {
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract, nextActionKind: 'develop' }).status, 'ready')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['CLOSED'], contract, nextActionKind: 'develop' }).status, 'ready')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['OPEN'], contract, nextActionKind: 'develop' }).status, 'blocked')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: ['UNKNOWN'], contract, nextActionKind: 'develop' }).status, 'dependency-unknown')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract: { ok: false, missing: ['验收标准'] }, nextActionKind: 'develop' }).status, 'invalid-contract')
  assert.equal(deriveAutoDevelopment({ issueState: 'OPEN', dependencyStates: [], contract, nextActionKind: 'resume' }).status, 'not-startable')
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
