# Dry-run 与自举验证设计

## 目标与边界

ClickVibe 的正式插件目前只有 GitHub Issue/PR 查看能力；一键开发仅存在于主 checkout 的未提交原型中。本次把该能力正式落入仓库，并完成 Issue #1 要求的 dry-run、增量日志和 worktree 恢复。

范围包括 `POST /clickvibe/api/develop`、`POST /clickvibe/api/develop/poll`、Issue 面板的一键开发区、`~/.clickvibe/config.yaml` 仓库映射，以及可重复验证的 Host 单元测试。不引入持久任务数据库、SSE、停止按钮、任务过期清理或自动合并；这些都不是 Issue #1 的验收项。

## 架构与数据流

Host 使用进程内任务表。`develop` 校验 GitHub Issue URL、agent 枚举和仓库映射后立即创建任务并返回 `taskId`；后台流程恢复或创建 issue worktree，再抓取 Issue 内容。`dryrun` 与真实 agent 共用同一 worktree 流程，但只执行 `pwd`、当前分支和 `git status --short --branch`，不启动 Codex/Claude，也不写代码。

每个任务维护带单调序号的有界日志行。后台以短间隔读取 shell 增量输出，把任意 chunk 拼接成完整行；任务结束时刷新最后一个不带换行的残片。轮询方传入 `cursor`，Host 返回其后的行、新 cursor、状态和 `truncated`。若调用方 cursor 已落后于已淘汰日志，响应首行给出明确截断提示。这样刷新、重试和多个轮询方不会互相消费日志。

## Worktree 恢复

恢复前分别探测分支 ref、目标路径和 Git worktree 注册表：

- 路径未注册：分支存在则从已有分支添加 worktree，分支不存在则从当前主仓库 HEAD 新建分支并添加。
- 路径已注册且分支正确：直接复用。
- 路径已注册但处于 detached HEAD，且目标分支不存在：在该 worktree 内创建目标分支。
- 路径已注册到其他分支、同一分支已被其他 worktree 占用，或路径是非空的普通目录：失败关闭并输出可操作错误，不自动删除用户数据。

所有 shell 参数使用 POSIX 单引号转义；worktree 创建需要修改主仓库 `.git`，沿用 DSH shell 的 `danger-full-access` 策略，并把 workspace root 限定为配置的仓库路径。

## 错误处理与验证

非法 agent 不得静默回退为 Codex。后台异常统一将任务置为 `failed` 并进入日志；UI 遇到轮询异常也停止定时器并展示错误。单元测试覆盖 URL/agent 解析、行缓冲 cursor 与截断、worktree 状态决策和 shell 转义。集成验收依次运行 typecheck/build/test、真实 HTTP dry-run、面板日志观察，并以当前 Issue #1 worktree 的最终 commit/push/PR 作为 Codex 自举证据。
