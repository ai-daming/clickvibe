/** Pure discussion writeback prompt; no GitHub or execution capabilities. */
export function boundAssessmentPrompt(url: string): string {
  return `请使用 gh-issue 整理本次讨论已确认结论并更新原 Issue：${url}。刷新目标正文和关系，展示精确变更；已有授权覆盖时执行，否则只询问尚未授权的变更。回读验证实际结果，不另建重复 Issue，不把推测当确认。完成后提示我返回 ClickVibe 查看重新评估结果。`
}
