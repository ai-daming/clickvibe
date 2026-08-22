# 状态读取 TTL Fetch 设计

## 目标与边界

`/state` 与 `repo/issues` 在推导 git 状态前刷新远端 refs，并共享同一个仓库级 TTL。默认 TTL 为 45 秒，`~/.clickvibe/config.yaml` 可通过 `fetchTtlSeconds` 配置，运行时约束在 30–60 秒。手动刷新绕过 TTL。fetch 失败不阻断读取，服务端继续使用本地 refs，并返回结构化 stale 标记供面板提示。

Git fetch 只负责 refs，不能代表 GitHub Issue 的依赖状态。依赖状态仍以 GitHub 的 OPEN/CLOSED 为准：5 秒 `/state` 轮询仅在共享 TTL 进入新周期时重拉 Issue 数据，使列表与详情的 blockedBy 同频更新，同时避免每 5 秒轰炸 GitHub API。

## 数据流与并发

进程内 `RepositoryFreshnessGate` 以规范化仓库路径为 key，记录最近尝试、最近成功、错误以及 in-flight promise。TTL 内的 `/state` 与 `repo/issues` 直接复用快照；并发请求复用同一 promise；失败尝试也按 TTL 节流。列表和详情的 ⟳ 传入 `forceRefresh`，强制发起一次新 fetch。

`/state` 在 fetch 完成或降级后才推导 worktree、`origin/main` 和远端分支差异。`repo/issues` 也先经过相同 gate，再加载 GitHub issues/PRs 和本地 refs。客户端收到 `freshness.refreshed=true` 时才同步刷新 GitHub 依赖快照；收到 `freshness.stale=true` 时显示“状态可能过期”。review 动作在启动 reviewer 之前执行 `git fetch origin --prune`，失败写入任务日志并继续。

## 验证

单元测试覆盖 TTL 内不重复、过期刷新、并发合并、强制刷新和失败降级。路由测试覆盖 `/state` 与 `repo/issues` 共用 fetch，以及 fetch 失败仍返回可读状态和 stale 标记。全套 TypeScript、Node 测试与构建作为交付门禁。
