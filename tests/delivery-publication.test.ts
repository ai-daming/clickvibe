import assert from 'node:assert/strict'
import test from 'node:test'
import { deliveryPublicationLabel, extractGithubCommentUrl } from '../src/delivery-publication.ts'

test('comment URL extraction selects the first valid GitHub comment URL amid extra output', () => {
  assert.equal(
    extractGithubCommentUrl([
      'warning: gh emitted a notice',
      'https://github.com/o/r/pull/35#issuecomment-123',
      'hint: done',
      'https://github.com/o/r/pull/35#issuecomment-456',
    ].join('\n')),
    'https://github.com/o/r/pull/35#issuecomment-123',
  )
})

test('comment URL extraction rejects non-comment and non-GitHub URLs', () => {
  assert.equal(extractGithubCommentUrl('https://example.com/o/r/pull/35#issuecomment-123'), undefined)
  assert.equal(extractGithubCommentUrl('https://github.com/o/r/pull/35'), undefined)
  assert.equal(extractGithubCommentUrl('warning only'), undefined)
})

test('failed publication renders the explicit GitHub failure label', () => {
  assert.equal(deliveryPublicationLabel({ target: 'pr', status: 'failed', error: 'offline' }), 'GitHub 评论发布失败')
  assert.equal(deliveryPublicationLabel(undefined), '本地事件')
})
