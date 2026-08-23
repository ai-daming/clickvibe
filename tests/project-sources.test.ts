import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectOption } from '../src/client/domain.ts'
import {
  deriveProjectSelection,
  mergeProjectSources,
  readDshWorkspaceSnapshot,
  resolveDshWorkspaceSource,
} from '../src/client/project-sources.ts'

const configured: ProjectOption[] = [
  { repoKey: 'ai-daming/clickvibe', path: '/work/clickvibe', available: true },
  { repoKey: 'owner/remote', path: '/work/remote', available: false },
]

test('project source union keeps configured repos and adds each DSH path once', () => {
  const projects = mergeProjectSources(configured, ['/work/clickvibe/', '/work/new-project', '/work/new-project/'])

  assert.deepEqual(projects, [
    { repoKey: 'ai-daming/clickvibe', path: '/work/clickvibe', available: true, configured: true },
    { repoKey: 'owner/remote', path: '/work/remote', available: false, configured: true },
    {
      repoKey: 'dsh:/work/new-project',
      path: '/work/new-project',
      available: true,
      configured: false,
    },
  ])
})

test('selecting an unconfigured DSH project clears repository sync state and stays read-only', () => {
  assert.deepEqual(
    deriveProjectSelection({
      repoKey: 'dsh:/work/new-project',
      path: '/work/new-project',
      available: true,
      configured: false,
    }),
    {
      loadRepository: false,
      repoAdvance: null,
      repoSyncMessage: null,
    },
  )

  assert.deepEqual(deriveProjectSelection(configured[0]), { loadRepository: true })
})

test('DSH workspace source reads the public list snapshot and reports host failures', () => {
  let listener: (() => void) | null = null
  const source = resolveDshWorkspaceSource({
    get(name) {
      assert.equal(name, 'workspaces')
      return {
        list: {
          getSnapshot: () => ({
            items: [
              { workspaceId: 'one', path: '/work/one' },
              { workspaceId: 'two', path: '/work/two' },
            ],
            state: 'idle',
            error: null,
          }),
          subscribe(next: () => void) {
            listener = next
            return () => {
              listener = null
            }
          },
        },
      }
    },
  })

  assert.ok(source)
  assert.deepEqual(readDshWorkspaceSnapshot(source), { paths: ['/work/one', '/work/two'], error: null })
  const dispose = source.subscribe(() => {})
  assert.ok(listener)
  dispose()
  assert.equal(listener, null)

  assert.equal(resolveDshWorkspaceSource({ get: () => undefined }), null)
  assert.deepEqual(
    readDshWorkspaceSnapshot({
      getSnapshot() {
        throw new Error('connection lost')
      },
      subscribe: () => () => {},
    }),
    { paths: [], error: 'DSH 项目读取失败: connection lost' },
  )
})
