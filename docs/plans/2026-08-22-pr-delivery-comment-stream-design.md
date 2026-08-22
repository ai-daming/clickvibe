# PR 交付与 Review 评论流水设计

## 目标与边界

每次开发任务成功进入 `review-ready` 时发布一条 Dev 评论；每次 Review 产生有效结论时发布一条 Review 评论。评论追加而不覆盖，并以固定 Meta 区块开头，成为 GitHub 上可追溯的交付节点。Dev 评论优先发到已关联 PR，没有 PR 时回退 Issue；Review 正常发到 PR，异常的无 PR 工作流沿用 Issue 回退以保留结论。

评论是公开审计记录，不是新的状态数据库。当前动作仍由 worktree HEAD、PR 实时事实、`workflow.reviewResult` 和绑定 HEAD 的本地事件共同推导。后续 agent 可以把 GitHub 评论正文原样放进提示词，但 ClickVibe 不解析 Meta 来恢复或覆盖状态。

## 方案选择

采用“纯正文构建器 + 单一发布函数 + 本地发布结果”方案。Dev 和 Review 各自提供结构化输入，由纯函数生成稳定 Markdown；发布函数统一通过 `gh issue comment --body-file -` 发送，避免 shell 转义破坏正文。完成回调等待发布结果，再结束任务，以保证面板收到完成事件时，评论成功或失败已经落入 workflow。

没有采用在两条回调中直接拼接 Markdown，因为字段顺序和措辞容易漂移；也没有把 GitHub 评论解析回状态，因为这违背 Issue #4 与 #20 的同正文、无隐藏协议约束。

## 数据流与失败处理

开发完成前先快照上一轮失败 Review 的问题列表，再清空当前 verdict。事件记录 `fixed` 数量和 GitHub 发布状态。首次开发的 `fixed` 为 0，摘要说明完成需求并可 Review；rework 评论列出上一轮问题。Review 评论记录当前短 SHA、结论、问题列表和明确下一步。

GitHub 发布失败不撤销已经真实完成的开发或 Review，也不伪造评论 URL。事件保存 `failed` 和错误摘要，日志追加失败原因，UI 在“交付流水”中明确显示“GitHub 评论发布失败”。成功则保存评论 URL，UI 提供直达链接。旧事件没有发布字段时标为“本地事件”，从而与新增 GitHub 流水清楚区分。

## UI 与验证

状态卡在最近一次开发事件有 `fixed` 时显示“首次交付”或“上次修复 N 个 Review 问题”。当前 Review 结论旁显示与评论一致的下一步：通过为“可合并”，失败为“请重新开发”。历史区改名为“交付流水”，每个事件展示 GitHub PR/Issue 评论链接、发布失败或本地事件。

验证覆盖固定 Meta 字段顺序、Dev 初次交付与 rework 摘要、Review 通过/失败正文、PR 与 Issue 目标选择、每轮追加发布，以及旧 workflow 的兼容显示。最后运行全量测试、类型检查和构建。
