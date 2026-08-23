import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveRepositoryAdvance, decideRepositorySync } from '../src/workflow/repository-sync-policy.ts'

test('repository advance exposes only comparable remote-default lag', () => {
  assert.deepEqual(
    deriveRepositoryAdvance({
      defaultBranch: 'main',
      checkoutBranch: 'feature/x',
      main: { behind: 4, ahead: 0 },
      checkout: { behind: 2, ahead: 1 },
    }),
    {
      defaultBranch: 'main',
      remoteRef: 'origin/main',
      mainBehind: 4,
      checkoutBranch: 'feature/x',
      checkoutBehind: 2,
    },
  )
  assert.equal(
    deriveRepositoryAdvance({
      defaultBranch: 'main',
      checkoutBranch: 'main',
      main: { behind: 0, ahead: 0 },
      checkout: { behind: 0, ahead: 0 },
    }).checkoutBehind,
    null,
  )
})

test('repository sync policy distinguishes ff, merge, refusal and independent main movement', () => {
  assert.deepEqual(
    decideRepositorySync({
      defaultBranch: 'main',
      checkoutBranch: 'feature/x',
      dirty: false,
      main: { behind: 3, ahead: 0 },
      checkout: { behind: 2, ahead: 0 },
    }),
    { checkout: 'fast-forward', main: 'fast-forward' },
  )
  assert.deepEqual(
    decideRepositorySync({
      defaultBranch: 'main',
      checkoutBranch: 'feature/x',
      dirty: false,
      main: { behind: 1, ahead: 1 },
      checkout: { behind: 2, ahead: 1 },
    }),
    { checkout: 'merge', main: 'diverged' },
  )
  assert.deepEqual(
    decideRepositorySync({
      defaultBranch: 'main',
      checkoutBranch: 'feature/x',
      dirty: true,
      main: { behind: 3, ahead: 0 },
      checkout: { behind: 2, ahead: 0 },
    }),
    { checkout: 'dirty', main: 'fast-forward' },
  )
  assert.deepEqual(
    decideRepositorySync({
      defaultBranch: 'main',
      checkoutBranch: null,
      dirty: false,
      main: { behind: 3, ahead: 0 },
      checkout: null,
    }),
    { checkout: 'detached', main: 'fast-forward' },
  )
})

test('checked-out default branch owns the local main update', () => {
  assert.deepEqual(
    decideRepositorySync({
      defaultBranch: 'main',
      checkoutBranch: 'main',
      dirty: false,
      main: { behind: 2, ahead: 0 },
      checkout: { behind: 2, ahead: 0 },
    }),
    { checkout: 'fast-forward', main: 'checked-out' },
  )
})
