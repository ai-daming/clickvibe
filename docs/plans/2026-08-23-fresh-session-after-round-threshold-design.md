# 超轮次后手动新开会话设计

## 范围

当本地事件链已有五次 review 结论、当前进入第六轮时，面板在现有续接动作旁提供“新开开发”或“新开 review”。主按钮、自动模式、worktree、分支、commit、事件链和公开交付历史均保持原语义。事件链缺失、阈值未达到、或没有归属明确的对应 session 时，不显示入口，服务端也拒绝 fresh 请求。

## 数据与授权

`deriveEventRound(events)` 继续是唯一轮次定义。状态派生新增 `freshSession: { round, develop, review }`，其中能力布尔值同时要求 `round > 5` 和 session id 与 agent owner 匹配。客户端只把该能力映射到 `resume/rework/review` 三类续接动作。

新开动作复用 `/resume` 与 `/review`，请求增加 `freshSession: true`。该字段进入一次性授权摘要与 digest，避免同一授权在“续接”和“新开”之间替换。执行时服务端重新检查阈值与 session，防止授权后状态漂移。

## 启动语义

fresh 开发清除旧开发 session 引用，使用 `buildFreshAgentCommand`，并向 `buildResumePrompt` 传入空 session id；现有 prompt 仍从当前需求快照、worktree 和上一轮未通过意见构造 rework 上下文。fresh review 同样不传旧 review session id，使用全新命令；`buildReviewPrompt` 因 session id 为空，不注入上一轮意见复核指令，只要求读取当前 `base...HEAD` 全量 diff。

任务完成仍走原有 `recordDevDelivery` 和 review 事件追加逻辑，因此轮次不重置。
