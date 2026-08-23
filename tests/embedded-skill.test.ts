import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.ts'
import { loadEmbeddedGhIssueSkill } from '../src/infra/embedded-skill.ts'

test('embedded gh-issue skill is loaded from the packaged skill document', () => {
  const skill = loadEmbeddedGhIssueSkill()

  assert.equal(skill.name, 'gh-issue')
  assert.equal(skill.source, 'clickvibe')
  assert.match(skill.description, /GitHub Issues/)
  assert.match(skill.content, /^# GitHub Issue Operator/m)
  assert.doesNotMatch(skill.content, /^---$/m)
})

test('host apply registers the embedded gh-issue runtime skill', () => {
  let registered: ReturnType<typeof loadEmbeddedGhIssueSkill> | undefined
  apply({
    skills: {
      register(skill: ReturnType<typeof loadEmbeddedGhIssueSkill>) {
        registered = skill
        return () => {}
      },
    },
    webServer: { register: () => () => {} },
    shell: {},
  } as never)

  assert.equal(registered?.name, 'gh-issue')
  assert.equal(registered?.source, 'clickvibe')
})
