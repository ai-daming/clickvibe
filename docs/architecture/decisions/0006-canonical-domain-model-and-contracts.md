# ADR-0006：Canonical Domain Model 与核心契约

> Status: Accepted | Date: 2026-08-26 | Partially superseded by: [ADR-0009](0009-v02-clean-break-local-state-and-config.md) for v0.1 local config/state cutover

## Context

v0.1 的 `IssueWorkflow` 同时承载身份、仓库绑定、任务所有权、Agent 会话、Review、自动运行、交付状态和事件数组；`WorkflowEvent` 依靠一个大对象上的可选字段表达多种事件。Git/GitHub 缓存、统一请求调度、Runtime Observer 和可观测性若继续各自新增同义字段，会形成多套 SHA、generation、evidence、status 和 identity 语义。

ClickVibe 当前以 GitHub Issue 为交付入口，但未来可能接入 GitLab、Gitea、Jira、Linear 或其他相似系统。GitHub 的数字 Issue number 是适配器表现，不是跨平台领域身份。

## Decision

建立 Canonical Domain Model 与版本化核心契约；物理实现按 roadmap 随真实消费者分阶段落地：

1. 核心工单身份采用 `provider + instance + container + id`；四个字段均为字符串。GitHub `#131` 映射为 `id: "131"`，数字验证与转换只留在 GitHub Adapter。
2. provider-neutral 的需求快照命名为 `WorkItemContractSnapshot`；v0.2 一个 Work Item 对应一个 Workflow，开发、Review、Observer、重试和恢复由 Run、round、generation 表达，不通过复制 Workflow 表达。
3. 所有判断共享 `DeliveryBasis`：Workflow、需求指纹、架构版本、baseline ref/SHA 和 exact head SHA。
4. Fact、Observation、Evidence、Cache、Event 与 Projection 是不同概念，缓存或投影不得提升事实等级。
5. 每个 Domain 拥有自己的契约；跨 Domain 只传 identity、ref、冻结快照或明确 command/result，不共享可变超级对象。
6. 目标持久化事件使用带 schemaVersion 的判别式 `EventEnvelope<type, payload>`，不继续扩展一个拥有大量可选字段的通用事件对象；完整因果事件链随 v0.3 自主决策生产者落地。v0.1 本地 config/state 的 v0.2 切换由 ADR-0009 部分替代本 ADR 的原迁移方向。
7. 事件用于审计、因果链和投影；不要求把整个系统重写成 Event Sourcing。控制状态仍由单一串行 workflow 命令域持久化。
8. UI DTO、缓存 TTL、模型/provider 选择、prompt 文本和展示状态属于可替换投影或策略，不纳入长期冻结核心。
9. v0.1 实现没有保留特权。每类资产按目标不变量和证据决定复用、重构、迁移、归档或废弃；需要保留的数据显式迁移，内部坏结构不以兼容为由进入 v0.2。

## Consequences

### Positive

- GitHub-first 的当前产品不阻塞未来 provider 适配，现有 `131` 可无损序列化为字符串。
- Review、Observer、merge gate、缓存和日志共享同一 Basis 与 Evidence 语言。
- generation、revision、sequence、round 和 step 不再互相冒充。
- Domain 边界和唯一写入者明确，减少跨模块整对象写与多事实源。

### Negative

- v0.1 本地 config/state 需要一次显式 clean break；旧 task/session/Review/event 不能在 v0.2 中直接恢复。
- 升级器必须跨 config、state 和多个 Git common-dir 管理可恢复阶段，不能依赖单文件原子性。
- Provider-neutral 核心会增加少量适配映射和类型数量。

### Neutral

- “GitHub-native”仍是产品与首个适配器定位，不等于核心类型只能表示 GitHub。
- 类型文档先于代码落地；物理目录和模块拆分在实现 Issue 中按现有单向依赖规则决定。
- v0.2 实现身份、ProjectBinding、WorkItemContract 和访问平面，并依 ADR-0009 从空 active state 开始；DeliveryBasis、WorkflowControlState、CapabilityLease 与完整 EventEnvelope 随 v0.3 的首个运行时消费者落地。契约已 Accepted 不等于要求 v0.2 预建无消费者类型。

## Alternatives Considered

- **继续使用 `issueNumber: number`**：拒绝。无法自然表达 Jira key、UUID 或其他字符串身份。
- **直接用 URL 当身份**：拒绝。URL 是可变 locator，仓库/项目改名或平台路由变化会破坏关联。
- **原样冻结 `IssueWorkflow`**：拒绝。它只用于 v0.1 历史资产盘点和冷备份说明，不是 v0.2 active migration 来源，也不是长期领域边界。
- **建立一个全局 `common/types.ts` 超级模块**：拒绝。统一语言不等于共享可变对象；契约必须由 Domain 拥有。
- **立即全面 Event Sourcing**：拒绝。当前没有需求证明其复杂度；分阶段追加审计事件与控制快照已经满足恢复和复盘目标。

## References

- [Canonical Domain Model](../canonical-domain-model.md)
- [核心数据契约](../core-contracts.md)
- [事实源与状态权威](../authority-model.md)
- [可观测性与复盘](../observability.md)
- [产品演进路线](../../roadmap.md)
- [v0.2 本地状态与配置 clean break](0009-v02-clean-break-local-state-and-config.md)
