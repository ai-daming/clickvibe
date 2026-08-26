# ADR-0007：Git 与 GitHub 三访问平面

> Status: Accepted | Date: 2026-08-26

## Context

ClickVibe 以 Work Item 为单位并行推进 Coding、Review、baseline 同步、冲突处理、PR 与合并。当前 Controller 和 Agent 都会调用 `git`/`gh`，但这些请求的作用域、成本和一致性边界不同：本地 Git 查询只读取一个 worktree；`fetch`、`push`、`ls-remote` 会争用仓库与远端；GitHub REST 受账号级 rate limit、网络延迟和资源新鲜度约束。把三者塞进一个万能缓存或全局队列，会扩大故障域并混淆事实权威。

Agent 必须保留完成 Coding、Review 和冲突解决所需的真实 Git/GitHub 权限。Agent 会话中的直接调用并不经过 Controller 进程，因此只治理 Controller 请求却声称已经治理“全部 git/gh 请求”是错误完成。

## Decision

v0.2 建立三个独立访问平面，并以 `WorkItemIdentity`、`ProjectBinding.repositoryId`、provider instance、remote 和操作类型形成稳定作用域：

1. **Local Git Snapshot** 按 repository/worktree 与刷新 generation 提供不可变本地观察。它只缓存无网络的 Git 读取；本地写动作、Agent 任务结束、worktree 变化和 Remote Git 操作后确定性失效。
2. **Remote Git Coordinator** 按 `repositoryId + remote` 协调 `fetch`、`push`、`ls-remote` 等共享远端操作。可合并的读取使用 singleflight；改变远端或本地 remote-tracking refs 的动作在仓库临界区串行化；动作后失效相关 Local Git Snapshot，并重新读取实际 refs，不能用预期结果推进。
3. **GitHub REST Gateway** 按 account/provider instance/repository/resource/operation 管理优先级、并发、singleflight、TTL/ETag 和 rate-limit 预算。写请求成功后失效受影响资源并回读权威状态；错误保留原始请求动作、响应和诊断引用。

Controller-owned 的 Git/GitHub 调用必须经过对应平面。Agent-owned 的直接 `git`/`gh` 调用继续拥有真实权限；ClickVibe 通过启动时提供 ObservationBundle、记录进程证据和在 push、PR 更新、Review、merge 等关键动作后由 Controller 重新观察，减少重复探测并验证结果，但不宣称这些直接调用已经被 Gateway 缓存。

三个平面只治理访问，不成为新的事实源。Git 对象与 refs、GitHub Issue/PR/Review/CI 事实仍由原生系统拥有；缓存条目必须携带 scope、source revision、observedAt、freshness/expiry 和 invalidation reason。每个平面都必须记录逻辑请求数、真实上游请求数、合并/命中、等待时间、失败、失效原因与写后回读结果；并发验收阈值必须在编码前冻结。

## Consequences

### Positive

- 高频面板刷新可以复用同一事实观察，减少 `gh api`、远端 Git 和本地 Git 重复请求。
- Remote Git 的仓库级冲突与 GitHub 的账号级压力分开治理，避免一个万能队列阻塞所有工作。
- Agent 保持解决真实冲突所需的自治能力，同时最终结果仍由 Controller 重读事实和门禁验证。
- 缓存作用域、失效和请求成本可以被计量、复盘和容量规划。

### Negative

- 必须静态枚举 Controller 与 Agent 的现有调用路径，并逐条迁移或标注所有者。
- 同一个用户动作可能跨多个平面，需要用 correlation id 串联而不能强行合并成一个事务。
- Agent 直接调用的请求量只能通过会话/进程证据观测和减少，无法由 Controller Gateway 完整拦截或缓存。

### Neutral

- 本决策不限制 Agent 使用 `git`、`gh` 或其他完成任务所需工具，也不授予其绕过 merge policy、CI、Review 或事实门禁的权限。
- 本决策不规定具体内存缓存库、数据库、TTL 数值或队列实现；这些参数由 v0.2 负载基线和验收阈值决定。
- 第二个 provider 接入前不提前抽象通用 provider SDK；核心 scope 保持 provider-neutral，GitHub Gateway 仍可使用 GitHub 专属响应类型在适配器边界内映射。

## Failure Modes

- **失效遗漏**：写后仍读到旧 Issue/PR/ref。处置：写入临界区内登记受影响 key，失效后回读；缺少回读则动作不算已确认。
- **check-then-write 竞争**：基于临界区外快照执行 push/merge。处置：所有权凭证与 generation 在串行化点内验证。
- **单仓库阻塞扩散**：慢 remote 或 rate limit 拖住无关仓库。处置：Remote Git 按 repository/remote 隔离，GitHub REST 按 account/instance 分预算与优先级。
- **缓存冒充事实**：过期 Observation 决定高风险动作。处置：动作门禁要求可证明 freshness；写前按策略刷新，写后强制重读。
- **治理盲区**：Agent 直接请求未进入 Gateway。处置：明确标注为 Agent-owned，采集可得证据并在关键副作用后重新观察；不得把 Controller 指标冒充全量指标。

## Alternatives Considered

- **一个全局 Git/GitHub 队列**：拒绝。作用域和一致性边界不同，会造成队头阻塞和故障域扩大。
- **禁止 Agent 直接使用 git/gh**：拒绝。会使 Coding、Review 和冲突修复失去完成真实任务所需能力。
- **只给所有请求加固定 TTL**：拒绝。写后失效、ETag、refs 变化和高风险动作的新鲜度要求不能由单一 TTL 表达。
- **只治理 Controller 且忽略 Agent**：拒绝。可以作为第一阶段实现范围，但必须显式报告盲区，不能宣称已经枚举或节省全部请求。

## References

- [产品演进路线](../../roadmap.md)
- [核心数据流](../core-data-flow.md)
- [事实源与状态权威](../authority-model.md)
- [核心数据契约](../core-contracts.md)
- [ADR-0002：权威事实与缓存边界](0002-authoritative-facts-and-cache.md)
- [ADR-0006：Canonical Domain Model 与核心契约](0006-canonical-domain-model-and-contracts.md)
