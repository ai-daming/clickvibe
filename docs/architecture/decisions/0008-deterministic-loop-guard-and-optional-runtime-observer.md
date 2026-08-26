# ADR-0008：确定性 Loop Guard 与可选 Runtime Observer

> Status: Accepted | Date: 2026-08-26 | Supersedes: [ADR-0005](0005-deterministic-loop-guard-and-runtime-observer.md)

## Context

ADR-0005 正确区分了纯规则 Loop Guard、任务级 Runtime Observer 和跨任务 Protocol Observer，也正确限制了模型的事实与动作权限；但它把“Loop Guard 触发后默认启动 Runtime Observer”写进主路径。这会让 v0.3 的安全停机依赖尚未证明价值的模型能力，并把 v0.6 的介入体验与模型诊断混成同一交付物。

Coding/Review 原地循环首先是工程控制问题：无论模型是否可用，系统都必须能基于持久化证据确定性停止。模型诊断是否能降低人工时间，需要用真实触发率、命中率、误导率、成本和延迟验证，不能先假设必然有价值。

## Decision

1. v0.3 的纯函数 Loop Guard 基于结构化跨轮证据只决定 `continue` 或 `stop`。`stop` 必须冻结同一 workflow 的普通 Coding/Review 推进，持久化暂停原因、最低完整证据和明确下一步，并能直接进入 `human-required`。
2. v0.6 必须交付人工介入产品化：查看冻结证据和失败母题、修改指令、选择受控恢复点，并在恢复前重新观察权威事实。这一交付不依赖模型 Runtime Observer。
3. Runtime Observer 是 v0.6 的可选诊断分支。只有数据证明它能降低人工处理成本且版本化策略启用时，`stop` 才可在 `human-required` 前进入一次任务专属、默认只读的 Observer 会话。
4. Observer 读取 exact HEAD、Work Item 契约、架构 baseline、完整 Review 历史和任务证据，输出结构化诊断与唯一下一轮指令。结果必须绑定 workflow generation 与 evidenceHash，并通过同一串行命令域提交。
5. Observer 无法验证关键 finding、输出不可解析、超时、需要扩大权限/修改业务合同，或唯一验证轮仍复发时，立即进入 `human-required`。模型不可解除冻结、修改代码、签发 CapabilityLease、绕过门禁或决定合并。
6. Runtime Observer 只诊断当前任务；跨任务协议候选交给 Protocol Observer，经独立设计、Review、版本化发布和回滚流程生效。

## Consequences

### Positive

- v0.3 即使没有模型、DSH 会话或浏览器也能阻止失控循环。
- v0.6 的介入体验可以独立发布，不被模型数据不足反向阻塞。
- 模型调用有明确数据门槛、次数预算和失败降级路径。
- 保留 ADR-0005 的只读、generation fencing 和协议隔离原则。

### Negative

- 纯规则停机后可能更早需要人介入，直到 Runtime Observer 的收益得到验证。
- 需要采集 Loop Guard 触发率、人工介入时间、诊断命中率/误导率、成本和延迟，才能决定是否启用模型分支。
- 状态机必须区分 `human-required` 与策略启用时的短暂 `observing`，并处理迟到结果。

### Neutral

- DSH 仍是首选 Runtime Observer 执行宿主，但不是 Loop Guard 安全性的依赖。
- 总轮次和预算上限继续作为最终保险；Observer 不负责决定自己的触发阈值。

## Alternatives Considered

- **维持 ADR-0005 的默认 Observer 路径**：拒绝。它让确定性安全边界依赖未验证的模型收益。
- **完全删除 Runtime Observer 概念**：拒绝。它可能显著降低复杂循环的人工诊断成本，应该保留为数据驱动候选。
- **由 Review Agent 自行决定是否继续**：拒绝。Review 位于同一循环内，触发不可独立重放和审计。
- **模型直接修改代码并继续循环**：拒绝。会混淆诊断与执行权限，也无法可靠约束迟到或错误判断。

## References

- [循环监督与 Observer](../observer-intervention.md)
- [自动化与信任](../automation-and-trust.md)
- [交付状态机](../workflow-state-machine.md)
- [可观测性与复盘](../observability.md)
- [产品演进路线](../../roadmap.md)
