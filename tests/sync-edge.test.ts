import assert from 'node:assert/strict'
import test from 'node:test'
import { syncWorktree } from '../src/workflow/sync.ts'

test('sync rejects malformed targets and issues without a worktree before git access', async () => {
  const invalid = await syncWorktree({} as never, undefined)
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.error, /请输入形如/)

  const pull = await syncWorktree({} as never, { url: 'https://github.com/o/r/pull/1' })
  assert.equal(pull.ok, false)
  if (!pull.ok) assert.match(pull.error, /请输入形如/)

  const missing = await syncWorktree({} as never, { url: 'https://github.com/o/r/issues/999999' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /尚无 worktree/)
})
