# Architecture Decision Records

> Status: Accepted

ADR 记录长期有效的架构取舍，不记录普通实现步骤。每个 ADR 必须包含状态、上下文、决策、取舍、失败模式和替代关系。

## 状态

- `Draft`：讨论中，不能作为 Coding Agent 的强制基线。
- `Accepted`：当前有效，Issue、Agent 和 Review 必须遵守。
- `Superseded`：由新 ADR 替代，保留用于解释历史代码。
- `Rejected`：评估过但未采用。

## 当前决策

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-architecture-source-of-truth.md) | Accepted | 架构文档的权威层级与生效机制 |
| [0002](0002-authoritative-facts-and-cache.md) | Accepted | Git/GitHub 权威事实与缓存边界 |
| [0003](0003-issue-architecture-gate.md) | Accepted | 业务 Issue 与架构设计分层 |
| [0004](0004-policy-controlled-autonomous-delivery.md) | Accepted | 策略控制的自动交付与合并 |
| [0005](0005-deterministic-loop-guard-and-runtime-observer.md) | Accepted | 确定性 Loop Guard 驱动独立 Runtime Observer |
| [0006](0006-canonical-domain-model-and-contracts.md) | Accepted | provider-neutral 核心身份、Domain 自有契约与判别式事件 |
