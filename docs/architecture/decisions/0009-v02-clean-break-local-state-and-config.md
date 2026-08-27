# ADR-0009：v0.2 本地状态与配置 clean break

> Status: Draft | Date: 2026-08-27 | Maintainer direction: clean break confirmed | Proposed partial supersession: [ADR-0006](0006-canonical-domain-model-and-contracts.md)

## Context

ADR-0006 将 v0.1 的 `IssueWorkflow`、`WorkflowEvent`、`repoKey` 和 Issue URL 视为迁移来源，并要求 v0.2 保留、迁移 legacy `WorkflowEvent` 的有效语义。该方向适合已有多用户安装或必须在线升级的产品，但 ClickVibe 当前仍是单用户使用的 0.x 实验版本。为了兼容未公开的本地格式而长期保留双解析、双身份和迁移分支，会让身份地基从第一天就背负无真实消费者的兼容成本。

当前本地状态还可能包含任务日志、Review 证据、冲突 worktree 和未推送提交。clean break 不能被解释为无备份删除，也不能覆盖 Git/GitHub 权威事实。配置、ClickVibe state、Git worktree/branch 和 Provider 事实必须分别处置。

## Decision

如果本 ADR 被接受，v0.2 按以下规则切换：

1. v0.2 active runtime 只接受 v0.2 `config.yaml` 和 state schema，不包含 v0.1 `repos`、`IssueWorkflow`、legacy workflow key 或 `WorkflowEvent` 的兼容读取/写入分支。
2. 升级前将整个 `~/.clickvibe/state` 原子改名为唯一的 `~/.clickvibe/state-v0.1-backup-<timestamp>-<nonce>`；随后在原路径创建新的空 `~/.clickvibe/state`。冷备份不参与 v0.2 运行，也不自动删除。
3. 旧 `config.yaml` 在精确预览和用户显式授权后一次性转换为 v0.2 ProjectBinding 格式；转换前保留原文件备份。v0.2 不把长期双格式解析当迁移方案。
4. Git worktree、local branch、remote branch、commit 和未提交文件不属于 ClickVibe state。升级只盘点并展示，不删除、不移动、不自动导入。新任务与既有 path/branch 冲突时 fail-closed，要求显式采用或清理。
5. GitHub Issue、PR、Review、CI 和 merge 继续由 Provider 回读；clean break 不修改这些事实。
6. 升级不是启动时的隐式副作用。流程必须是检测、精确预览、显式授权、分阶段执行、逐项回读；任一步不确定时 v0.2 保持不可写。
7. 冷备份仅作为人工恢复和审计材料。它不授权 v0.2 动作，旧 Review、task/session、stage 或 event 不自动进入新 state。

本 ADR 只改变 v0.1 本地状态和配置的升级策略。它不改变 ADR-0006 的 provider-neutral 身份、Domain 边界、事实等级和未来事件契约。

## Required Baseline Changes Before Acceptance

接受本 ADR 前必须在同一设计变更中同步：

- `docs/roadmap.md` 中“v0.2 保留并迁移 legacy WorkflowEvent”的要求；
- `docs/architecture/canonical-domain-model.md`、`core-contracts.md` 和 `observability.md` 的 legacy event 排期；
- Issue #134 的旧 key 兼容/迁移验收与 L3 baseline；
- Issue #136 对 legacy `WorkflowEvent` 的验收标准；
- Issue #137 对 v0.1 资产逐类迁移的范围，使其区分 active migration、cold archive 和 Git 现场处置。

本地文档提案与 GitHub Issue #132、#134、#136、#137 已在 2026-08-27 按 clean break 方向同步；在本设计 PR 的 exact-SHA Review 通过并合入前，本 ADR 保持 Draft，不能作为 Coding Agent 的基线。

## Consequences

### Positive

- v0.2 从第一天只有一个身份模型、一个配置 schema 和一个 active state 写入模型。
- 删除长期兼容代码、双写和旧 key 猜测，缩小 #134、#136 和后续访问平面的状态空间。
- 原始本地数据仍有冷备份；Git/GitHub 事实不因控制状态重置而丢失。
- 升级机制本身形成可预览、可恢复、可回读的产品边界。

### Negative

- v0.1 task/session、Review 结论和 workflow stage 不能在 v0.2 中直接恢复。
- 旧 worktree 只作为外部 Git 现场保留；需要继续时必须重新观察、重新授权并重新 Review。
- 用户必须完成一次显式升级，不能直接用 v0.2 打开 v0.1 state。
- 当前 Accepted 文档和 #136/#137 必须重新对齐，设计工作量前置。

### Neutral

- 冷备份可在 v0.2 稳定验收后由用户另行授权删除；本 ADR 不规定自动保留期限。
- 多机器绑定只要求相同 Work Item identity 和不同 ProjectBinding；机器注册、在线状态与执行路由仍属于后续版本。

## Failure Modes and Required Handling

- **仍有 live task**：升级停止；持久化 `running` 不是活性证明，必须检查当前进程 handle 与宿主 job。
- **旧配置无效或仓库不可验证**：不生成可执行计划，不改任何文件。
- **升级中途失败**：保留阶段 journal 和所有备份；不得进入普通运行模式。允许按已验证阶段继续或回滚。
- **Git common-dir 不可写**：对应 Binding 失败，其他 Binding 不得掩盖该失败。
- **repositoryId 缺失或不一致**：首次注册可原子创建；已绑定后的缺失/不一致必须显式 rebind。
- **旧 worktree dirty/conflicted/ahead**：原样保留并展示，不能自动 reset、stash、删除或推送。
- **备份目标已存在**：生成新的 timestamp + nonce 目标，禁止覆盖。

## Alternatives Considered

- **继续 ADR-0006 的兼容读取与逐条迁移**：保留更多运行历史，但为单用户 0.x 格式引入长期双 schema、双身份和测试矩阵；本提案拒绝。
- **启动时自动升级**：少一次确认，但会在普通启动中改 `.git`、配置和本地状态；拒绝。
- **直接删除 v0.1 state**：最简单，但不可恢复地丢失任务与审计证据；拒绝。
- **自动导入既有 worktree**：可能恢复部分现场，但无法可靠恢复 task ownership、Review basis 和 session；拒绝，保留显式采用入口作为未来需求。

## References

- [#134 WorkItemIdentity 与 ProjectBinding L3 设计](../../plans/2026-08-27-work-item-identity-project-binding-design.md)
- [事实源与状态权威](../authority-model.md)
- [核心数据契约](../core-contracts.md)
- [Issue 架构门禁](0003-issue-architecture-gate.md)
