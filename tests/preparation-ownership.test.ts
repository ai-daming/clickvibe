import assert from 'node:assert/strict'
import test from 'node:test'
import { preparationBlockReason } from '../src/infra/task-ownership.ts'
import { autoRunWorkflowFixture } from './workflow-fixture.ts'
const workflow = autoRunWorkflowFixture('/fixture', '170')
test('unclaimed host reservation and an unreadable registry both block preparation', () => {
  assert.match(preparationBlockReason({}, workflow) ?? '', /无法确认/)
  assert.match(
    preparationBlockReason(
      {
        jobs: {
          list() {
            throw new Error('unavailable')
          },
          get() {
            throw new Error('unused')
          },
        },
      },
      workflow,
    ) ?? '',
    /无法确认/,
  )
  const orphan = {
    id: 'host-1',
    kind: 'clickvibe',
    label: `clickvibe:${workflow.key}:dev:dev-1-a`,
    status: 'running' as const,
    startedAt: 1,
  }
  assert.match(preparationBlockReason({ jobs: { list: () => [orphan], get: () => orphan } }, workflow) ?? '', /占用/)
  assert.equal(
    preparationBlockReason(
      {
        jobs: {
          list: () => [],
          get() {
            throw new Error('unused')
          },
        },
      },
      workflow,
    ),
    null,
  )
})

test('unrelated unlabeled jobs do not look like a failed preparation for this workflow', () => {
  const jobs = [{ id: 'foreign', kind: 'other-plugin', status: 'running', startedAt: 1 }]
  assert.equal(
    preparationBlockReason(
      {
        jobs: {
          list: () => jobs,
          get() {
            throw new Error('unused')
          },
        },
      } as never,
      workflow,
    ),
    null,
  )
})
