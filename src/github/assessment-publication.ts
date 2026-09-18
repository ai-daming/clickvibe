/** Reuse GitHub write admission and readback, without making publication a development gate. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssessmentRun, AssessmentReport } from '../infra/assessment-types.ts'
import type { AssessmentStore } from '../infra/assessment-store.ts'
import { githubWrite, githubWriteOutcomeError } from './writes.ts'
import { githubRead } from './operations.ts'
export async function publishAssessment(
  ctx: Context,
  store: AssessmentStore,
  run: AssessmentRun,
  report: AssessmentReport,
) {
  const number = Number(new URL(run.input.url).pathname.split('/').at(-1))
  const publicText = report.text.replaceAll(run.input.repoPath, '.')
  const body = `身份：开发准备评估 Agent\n\n${publicText}\n\n评估依据：${run.input.baseOid}\n\n<!-- clickvibe-assessment:${run.id}:${run.reportHash} -->`
  if (run.publication.status === 'published' || run.publication.status === 'failed') return
  if (run.publication.status === 'unknown') {
    const comments = (await githubRead(ctx, {
      operation: 'issue-comments',
      repoKey: run.input.repoKey,
      number,
      consistency: 'upstream-confirmed',
    })) as { id: number; body: string }[]
    const matches = comments.filter((comment) => comment.body === run.publication.body)
    if (matches.length === 1)
      await store.publication(run.id, 'unknown', {
        status: 'published',
        body: run.publication.body,
        commentId: matches[0].id,
      })
    else {
      const detail =
        matches.length === 0
          ? '未找到匹配评论不代表发布失败；保持待核实，不会重复发布。可稍后再次核对，本地报告仍可使用。'
          : '找到多条匹配评论，无法确认唯一发布结果；请核查 GitHub 评论，不会重复发布。'
      const original = run.publication.error
      await store.publication(run.id, 'unknown', {
        ...run.publication,
        error: original?.includes(detail) ? original : [original, detail].filter(Boolean).join('\n'),
      })
    }
    return
  }
  const outcome = await githubWrite<{ repoKey: string; number: number; body: string }, { id: number }>(ctx, {
    operation: 'issue-comment-create',
    input: { repoKey: run.input.repoKey, number, body },
    persistMarker: () => store.publication(run.id, 'pending', { status: 'unknown', body }),
  })
  if (outcome.outcome === 'confirmed') {
    if (outcome.value?.id)
      await store.publication(run.id, 'unknown', { status: 'published', body, commentId: outcome.value.id })
    else await publishAssessment(ctx, store, { ...run, publication: { status: 'unknown', body } }, report)
  } else {
    const current = (await store.list()).find((item) => item.id === run.id)!
    await store.publication(run.id, current.publication.status, {
      status: outcome.outcome === 'failed' ? 'failed' : 'unknown',
      body,
      error: githubWriteOutcomeError(outcome),
    })
  }
}
