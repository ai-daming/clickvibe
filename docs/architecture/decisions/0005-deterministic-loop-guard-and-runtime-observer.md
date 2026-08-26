# ADR-0005：确定性 Loop Guard 驱动独立 Runtime Observer

> Status: Accepted | Date: 2026-08-26

## Context

Coding 和 Review 都在交付循环内部，不能可靠判断当前修法是否仍在收敛。v0.1 只有总轮次/预算上限和一个面向协议演化的 Observer Skill；若等待总上限，Agent 可能在同一母题上重复返工，若让模型自行决定何时介入，则触发本身不可复现、不可审计。

DSH 已提供任务会话和模型运行时，但 ClickVibe 当前只使用了打开会话并预填草稿的客户端桥。运行时介入必须在无人值守时成立，不能依赖浏览器或用户当前 Chat。

## Decision

每次 Review 结论持久化后，由纯函数 Loop Guard 基于结构化跨轮证据决定 `continue`、`observe` 或 `human-required`。触发规则至少覆盖显式 `stop-and-redesign`、同一 CRITICAL 母题连续复发、连续失败轮次和 diff 发散。

`observe` 冻结同一 workflow 的普通 Coding/Review 推进，并由宿主侧在 DSH 创建任务专属、默认只读的 Runtime Observer 会话。Observer 读取 exact HEAD、Issue 契约、架构 baseline、完整 Review 历史和任务证据，返回结构化判决与唯一下一轮指令。结果必须绑定 workflow generation 与 evidenceHash，并通过同一串行命令域提交。

Runtime Observer 只修正当前任务路线；现有 `skills/observer` 明确为 Protocol Observer，跨任务审计系统性盲区。协议候选不得由运行时会话直接修改全局 prompt、Skill、门禁或架构，必须经过普通设计与 Review 流程。

## Consequences

### Positive

- 在人工介入前阻止 Coding/Review 原地循环，同时保留无人值守交付能力。
- 触发可重放、判决可审计，模型不能自行扩大调用频率或权限。
- DSH 成为统一 Agent/模型运行时，ClickVibe 不绑定单一模型 SDK。
- 运行时任务修正与长期协议演化分离，避免单个异常污染全局规则。

### Negative

- Review 事件必须新增 theme、severity/finding identity、diff 趋势等结构化证据。
- Controller 需要新的正交 loop-control 状态、Observer 任务监督和迟到结果 fencing。
- Observer 会增加模型成本和交付时延；触发阈值需要用真实复盘校准。

### Neutral

- Observer 输出仍是不可信判断；Git、GitHub、CI、测试和 exact-head Review 的权威等级不变。
- 现有总轮次与预算上限继续作为最终保险，但不再承担早期诊断职责。

## Alternatives Considered

- **只依赖 Review 自行输出 stop-and-redesign**：拒绝。Review 仍在循环内，历史上已出现规则存在但无人触发的情况。
- **每轮都启动 Observer**：拒绝。成本高，并会让 Observer 变成循环内常设 reviewer，复制新的系统性盲区。
- **固定第 N 轮直接交给人**：拒绝作为主路径。它能止损但牺牲无人值守能力，也无法识别第二轮已经明显复发的母题。
- **让 Runtime Observer 自动修改全局协议**：拒绝。单任务证据不足以授权系统级变更，自修改必须进入独立 Protocol Observer 与架构 Review。

## References

- [循环监督与 Observer](../observer-intervention.md)
- [自动化与信任](../automation-and-trust.md)
- [可观测性与复盘](../observability.md)
- [Protocol Observer Skill](../../../skills/observer/SKILL.md)
