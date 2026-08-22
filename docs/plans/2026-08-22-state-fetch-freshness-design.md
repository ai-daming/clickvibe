# 状态读取 TTL Fetch 设计

## 目标与边界

`/state` 与 `repo/issues` 在推导 git 状态前刷新远端 refs，并共享同一个仓库级 TTL。默认 TTL 为 45 秒，`~/.clickvibe/config.yaml` 可通过 `fetchTtlSeconds` 配置，运行时约束在 30–60 秒。手动刷新绕过 TTL。fetch 失败不阻断读取，服务端继续使用本地 refs，并返回结构化 stale 标记供面板提示。

Git fetch 只负责 refs，不能代表 GitHub Issue 的依赖状态。依赖状态仍以 GitHub 的 OPEN/CLOSED 为准：5 秒 `/state` 轮询仅在共享 TTL 进入新周期时重拉 Issue 数据，使列表与详情的 blockedBy 同频更新，同时避免每 5 秒轰炸 GitHub API。

## 数据流与并发

进程内 `RepositoryFreshnessGate` 以规范化仓库路径为 key，记录最近尝试、最近成功、错误以及 in-flight promise。TTL 内的 `/state` 与 `repo/issues` 直接复用快照；并发请求复用同一 promise；失败尝试也按 TTL 节流。查看路径最多等待 fetch 两秒，超时便返回 stale 本地 refs，后台 fetch 继续；已有 fetch 进行中时后续轮询立即返回，不重复等待。列表和详情的 ⟳ 传入 `forceRefresh`，强制发起或复用一次 fetch。

`/state` 在 fetch 完成或有界降级后推导 worktree、`origin/main` 和远端分支差异。`repo/issues` 也经过相同 gate，再加载 GitHub issues/PRs 和本地 refs。GitHub 依赖使用独立的 repo 级 TTL clock，因此没有本地路径的远程配置项目也会自动刷新；客户端轮询有 in-flight 去重与超时，依赖二次拉取失败时保留旧数据并显示单独的过期提示。多仓库 freshness 同时返回仓库数、成功数与 partial 标记。review 动作在启动 reviewer 之前执行 `git fetch origin --prune`，失败写入任务日志并继续。

## 验证

单元测试覆盖 TTL 内不重复、过期刷新、并发合并、有界等待、强制刷新、失败降级和部分成功聚合。路由测试覆盖 `/state` 与 `repo/issues` 共用 fetch、远程配置项目的依赖刷新时钟，以及 fetch 挂起时仍快速返回可读状态和 stale 标记。全套 TypeScript、Node 测试与构建作为交付门禁。
