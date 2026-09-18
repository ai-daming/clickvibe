/** An assessment is optional prompt context, never a development prerequisite. */
import type { PromptSnapshot } from '../infra/contracts.ts'
import { stateDir } from '../infra/state.ts'
import { AssessmentStore } from '../infra/assessment-store.ts'
export async function withAssessmentPrompt(snapshot: PromptSnapshot): Promise<PromptSnapshot> {
  const prompt = structuredClone(snapshot)
  try {
    const store = new AssessmentStore(stateDir())
    const run = [...(await store.list())]
      .reverse()
      .find((item) => item.input.url === snapshot.url && item.phase === 'completed')
    if (!run) return prompt
    const report = await store.report(run)
    if (report)
      prompt.comments.push({
        author: '开发准备评估 Agent',
        body: `历史评估参考（代码依据 ${run.input.baseOid}；${run.input.body === snapshot.body ? 'Issue 正文与评估时一致' : 'Issue 正文已变化'}）。本报告不构成开发前置，也不代表新基线已复核。\n\n${report.text}`,
      })
  } catch (error) {
    prompt.comments.push({
      author: 'ClickVibe',
      body: `已有评估读取失败，继续按原 Issue 工作：${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return prompt
}
