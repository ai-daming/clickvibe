import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conflictFileSuffix,
  fetchOriginBranches,
  listConflictFiles,
  readBranch,
  readRefShort,
  readRevCount,
} from '../src/infra/git.ts'

function ctxFor(handler: (command: string) => { exitCode: number; stdout?: string; stderr?: string } | never) {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        const result = handler(spec.command)
        return {
          exitCode: result.exitCode,
          stdout: { text: result.stdout ?? '' },
          stderr: { text: result.stderr ?? '' },
        }
      },
    },
  }
}

test('git readers return null for command failures, exceptions, empty refs and malformed counts', async () => {
  const failed = ctxFor(() => ({ exitCode: 1 }))
  assert.equal(await readRefShort(failed as never, '/repo', 'HEAD'), null)
  assert.equal(await readBranch(failed as never, '/repo'), null)
  assert.equal(await readRevCount(failed as never, '/repo', 'main', 'HEAD'), null)

  const empty = ctxFor((command) => ({ exitCode: 0, stdout: command.startsWith('git rev-list') ? 'x y' : '  ' }))
  assert.equal(await readRefShort(empty as never, '/repo', 'HEAD'), null)
  assert.equal(await readBranch(empty as never, '/repo'), null)
  assert.equal(await readRevCount(empty as never, '/repo', 'main', 'HEAD'), null)

  const thrown = ctxFor(() => {
    throw new Error('offline')
  })
  assert.equal(await readRefShort(thrown as never, '/repo', 'HEAD'), null)
  assert.equal(await readBranch(thrown as never, '/repo'), null)
  assert.equal(await readRevCount(thrown as never, '/repo', 'main', 'HEAD'), null)
})

test('conflict helpers trim files, degrade errors and format only nonempty suffixes', async () => {
  const readable = ctxFor(() => ({ exitCode: 0, stdout: ' src/a.ts \n\n src/b.ts\n' }))
  assert.deepEqual(await listConflictFiles(readable as never, '/repo'), ['src/a.ts', 'src/b.ts'])
  assert.equal(conflictFileSuffix(['src/a.ts', 'src/b.ts']), ';冲突文件:src/a.ts、src/b.ts')
  assert.equal(conflictFileSuffix([]), '')
  assert.deepEqual(await listConflictFiles(ctxFor(() => ({ exitCode: 1 })) as never, '/repo'), [])
})

test('origin branch enumeration falls back to main and rejects repositories without a default', async () => {
  const fallback = ctxFor((command) => {
    if (command.includes('symbolic-ref')) return { exitCode: 1 }
    if (command.includes('show-ref')) return { exitCode: 0, stdout: '0' }
    if (command.includes('for-each-ref')) return { exitCode: 0, stdout: 'origin/main\n\norigin/release\n' }
    return { exitCode: 0 }
  })
  assert.deepEqual(await fetchOriginBranches(fallback as never, 'o/r', '/repo'), {
    defaultRemoteBase: 'origin/main',
    refs: ['origin/main', 'origin/release'],
  })
  const missing = ctxFor((command) =>
    command.includes('symbolic-ref')
      ? { exitCode: 1 }
      : { exitCode: 0, stdout: command.includes('show-ref') ? '1' : '' },
  )
  await assert.rejects(fetchOriginBranches(missing as never, 'o/r', '/repo'), /无法确定 origin 默认分支/)
})
