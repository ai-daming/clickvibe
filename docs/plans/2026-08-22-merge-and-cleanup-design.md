# Issue #23：合并执行与合并后清理设计

## 目标与边界

ClickVibe 的「合并 PR」动作改为本机受控执行，不再打开 GitHub。服务端在一次短期、单次使用的特权授权里展示并绑定 PR 号、分支、固定的 `--merge` 策略和清理范围；用户确认后，服务端重新读取实时 PR 事实和本地 review 事实，只有 PR HEAD 与最近一次通过的 review 事件哈希一致时才执行 `gh pr merge --merge`。#31 尚未进入 `main`，因此本次只接入当前保证存在的 HEAD 门禁；#31 后续增加的 Issue 契约门禁仍位于同一合并前置校验边界。

合并和清理不能被建模成一个可回滚事务：GitHub 合并成功后无法因为本地删除失败而撤销。因此 workflow 增加持久化 delivery 状态。合并命令成功后必须重新查询 GitHub 并确认 `MERGED`，随后先持久化 `merged`，再开始清理。此后发生的错误只产生 `cleanup-pending`，状态模型提供「重试清理」，不会退回「合并 PR」。合并命令本身失败时不写 delivery 状态，原 review/PR 状态保持不变并透传 CLI 错误。

## 清理链与归档

清理按顺序、可重入执行：移除 worktree、删除本地分支、删除远端分支、关闭 Issue、归档 workflow。每一步完成后都写入 workflow；重试跳过已完成步骤。为避免清理失败后 Issue 从活跃列表消失，Issue 关闭放在本地和远端 Git 清理之后。`gh pr merge --merge` 的 merge commit body 写入 `Closes #N`；若 GitHub 没有自动关闭 Issue，再显式关闭。

worktree 使用非强制 `git worktree remove`，存在未提交或未跟踪成果时失败并保留现场；本地分支只在实时确认该 PR 已合并且 HEAD 门禁通过后删除。远端分支先检查是否存在，已被 GitHub 删除视为幂等成功。全部清理完成后，workflow JSON 原子移动到 `state/archive/`。活跃加载只读取顶层 workflow；按 URL 查询时同时读取归档，以便详情仍能显示「已交付」。

`/state` 每次读取实时 Issue 与 PR 状态；GitHub 暂时不可用时，已持久化的 merged 事实仍保持终态。项目 Issue 列表继续以 GitHub OPEN Issue 为入口，归档项不会重新进入活跃列表。

## UI 与验证

详情和列表的合并动作都先进入同一个详情流程。授权预览由服务端生成，确认框明确展示 PR、分支、`--merge` merge commit、worktree/本地分支/远端分支/Issue/workflow 归档清理范围。确认后调用 `/merge`；成功则刷新详情和项目 Issue 列表，清理失败则显示原始错误并保留「重试清理」。

测试覆盖：无特权头/无授权拒绝；预览字段；授权单次使用；review hash 过期拒绝且不调用 merge；merge CLI 失败不倒退；合并成功严格使用 `--merge` 与 `Closes #N`；各清理步骤顺序与归档；已 merged 的重试不重复合并；`/state` 实时同步手动关闭的 Issue；归档 workflow 可按 URL 恢复但不出现在活跃集合。最后执行 typecheck、完整单元测试和 build。
