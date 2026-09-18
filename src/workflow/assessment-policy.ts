/** Pure report interpretation; no report verdict can disable development. */
import type { AssessmentReport, AssessmentRun, AssessmentVerdict } from '../infra/assessment-types.ts'
const verdicts: readonly string[] = [
  'READY',
  'NEEDS_DECISION',
  'NEEDS_EVIDENCE',
  'DESIGN_REQUIRED',
  'AWAITING_ACCEPTANCE',
  'REFRAME',
]
export function assessmentReport(text: string): AssessmentReport {
  const matches = [...text.matchAll(/^\s*(?:\*\*)?Implementation Gate:\s*([A-Z_]+)(?:\*\*)?\s*$/gm)]
  if (matches.length !== 1 || !verdicts.includes(matches[0][1]) || text.trim().split('\n').length < 3)
    throw new Error('评估报告缺少唯一的原始结论及说明')
  return { verdict: matches[0][1] as AssessmentVerdict, text }
}
export function assessmentView(run: AssessmentRun | undefined, basis: string) {
  if (!run) return { label: '未评估', discussion: false }
  const labels = {
    queued: '等待评估',
    running: '正在评估',
    completed: '评估完成',
    failed: '评估失败',
    interrupted: '评估中断',
    cancelled: '已取消评估',
  }
  return {
    label:
      run.input.basis !== basis
        ? '评估依据已变化'
        : run.phase === 'completed'
          ? ({
              READY: '准备情况明确',
              NEEDS_EVIDENCE: '需要补查证据',
              NEEDS_DECISION: '有待确认事项',
              DESIGN_REQUIRED: '需要补设计',
              AWAITING_ACCEPTANCE: '设计待确认',
              REFRAME: '需要重新讨论目标',
            }[run.verdict!] ?? labels.completed)
          : labels[run.phase],
    discussion:
      run.phase === 'completed' &&
      ['NEEDS_DECISION', 'DESIGN_REQUIRED', 'AWAITING_ACCEPTANCE', 'REFRAME'].includes(run.verdict ?? ''),
  }
}
