export const ISSUE_ORGANIZER_PROMPT = `请使用 gh-issue 技能整理本次讨论：
1. 先复述本次讨论已经形成的结论，供我校验，不要把推测当成结论。
2. 刷新 GitHub 现状，判断应新建一个或多个 Issue，还是更新已有类似 Issue。
3. 按仓库的 Issue 契约起草，每个 Issue 至少包含 ## 目标、## 验收标准、## 依赖，并保留必要的约束和入口。
4. 在任何写操作前展示逐项精确预览；只有等我对每一项逐项明确授权后才执行。
5. 执行后重新读取 GitHub，核验实际结果并报告任何偏差。`

export interface IssueOrganizerInputActions {
  setDraft(text: string): void
  submit(): void
}

export function submitIssueOrganization(actions: IssueOrganizerInputActions): void {
  actions.setDraft(ISSUE_ORGANIZER_PROMPT)
  actions.submit()
}
