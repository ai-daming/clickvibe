import assert from 'node:assert/strict'
import test from 'node:test'
import { issueSnapshot } from '../src/github/issue.ts'
import { detectLinkedPr } from '../src/github/pr.ts'

function ghCtx(body: unknown, exitCode = 0) {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run() {
        return {
          exitCode,
          stdout: { text: ['HTTP/2.0 200 OK', '', JSON.stringify(body)].join('\n') },
          stderr: { text: exitCode === 0 ? '' : 'offline' },
        }
      },
    },
  }
}

test('linked PR detection returns a number and degrades missing or failed responses to null', async () => {
  assert.equal(await detectLinkedPr(ghCtx([{ number: 7 }]) as never, 'o/r', 'feature'), '7')
  assert.equal(await detectLinkedPr(ghCtx([{}]) as never, 'o/r', 'feature'), null)
  assert.equal(await detectLinkedPr(ghCtx([]) as never, 'o/r', 'feature'), null)
  assert.equal(await detectLinkedPr(ghCtx({}, 1) as never, 'o/r', 'feature'), null)
})

test('issue snapshot rejects invalid URLs and normalizes sparse comments and fields', () => {
  assert.throws(() => issueSnapshot({ url: 'not github' }), /无效 URL/)
  assert.deepEqual(
    issueSnapshot({
      url: 'https://github.com/o/r/issues/1',
      comments: [
        { author: null, body: null },
        { author: { login: 'owner' }, body: 'note' },
      ],
    }),
    {
      url: 'https://github.com/o/r/issues/1',
      title: '',
      body: '',
      state: '',
      updatedAt: '',
      comments: [
        { author: 'unknown', body: '' },
        { author: 'owner', body: 'note' },
      ],
    },
  )
  assert.deepEqual(issueSnapshot({ url: 'https://github.com/o/r/issues/2', comments: 'invalid' }).comments, [])
})
