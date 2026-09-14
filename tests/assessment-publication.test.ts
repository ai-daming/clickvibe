import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { AssessmentStore } from '../src/infra/assessment-store.ts'
import { publishAssessment } from '../src/github/assessment-publication.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { recoveryHome } from './helpers/recovery-home.ts'

const baseReport = {
  verdict: 'NEEDS_EVIDENCE' as const,
  text: 'Implementation Gate: NEEDS_EVIDENCE\nWork: o/r#177\n需要现场证据。',
}
for (const immediateReadback of [false, true])
  test(`lost POST response is reconciled without repeating writes (immediate readback: ${immediateReadback})`, async () => {
    const { home } = await recoveryHome([])
    const report = { ...baseReport, text: `${baseReport.text}\n${home}/src/file.ts` }
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const store = new AssessmentStore(`${home}/.clickvibe/state-recovery-1`)
      await store.submit([
        {
          url: 'https://github.com/o/r/issues/177',
          repoKey: 'o/r',
          repoPath: home,
          title: 'Issue',
          body: 'Goal',
          basis: 'a',
          baseOid: 'a'.repeat(40),
          model: { provider: 'test', model: 'test' },
        },
      ])
      const claimed = await store.claim()
      assert.ok(claimed)
      await store.complete(claimed, report)
      const comments: { id: number; body: string }[] = []
      let posts = 0
      let readbackAvailable = immediateReadback
      const ctx = {
        effect: () => () => {},
        shell: {
          resolve: (spec: unknown) => spec,
          async run(spec: { command: string; stdin?: string }) {
            if (spec.command.includes('--method')) {
              posts++
              comments.push({ id: 42, body: JSON.parse(spec.stdin!).body })
              throw new Error('response lost after server accepted the comment')
            }
            if (!readbackAvailable) throw new Error('readback temporarily unavailable')
            return {
              exitCode: 0,
              stdout: { text: `HTTP/2.0 200 OK\n\n${JSON.stringify(comments)}` },
              stderr: { text: '' },
            }
          },
        },
      }
      await publishAssessment(ctx as never, store, (await store.list())[0], report)
      const unknown = (await store.list())[0]
      assert.equal(unknown.publication.status, immediateReadback ? 'published' : 'unknown')
      assert.equal((await store.report(unknown))?.text, report.text)
      assert.equal(posts, 1)
      assert.equal(comments[0].body.includes(home), false)
      readbackAvailable = true
      await publishAssessment(ctx as never, new AssessmentStore(`${home}/.clickvibe/state-recovery-1`), unknown, report)
      assert.equal((await store.list())[0].publication.status, 'published')
      assert.equal((await store.list())[0].publication.commentId, 42)
      assert.equal(posts, 1)
      await publishAssessment(ctx as never, store, (await store.list())[0], report)
      assert.equal(posts, 1)
    } finally {
      resetGithubGatewayOwnerForTests()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
