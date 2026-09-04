# ADR-0015：EventEnvelope 判别式因果链——Decision→Action→Re-observe 随真实生产者落地

> Status: Accepted | Date: 2026-09-04 | Issue: #168（v0.3.0） | 落实: [ADR-0006](0006-canonical-domain-model-and-contracts.md) 判别式事件契约的 v0.3 首切片 | 依赖: [ADR-0014](0014-autonomous-delivery-control-and-trust.md)（lease/guard 是首批真实生产者） | 地基: [ADR-0012](0012-work-item-contract-canonicalization-and-evidence.md) 诊断关联模式

## Context

roadmap 明确：v0.2 不建完整自主决策事件总包，「判别式 EventEnvelope 及首条 Decision→Action→Re-observe 因果链在 v0.3 随真实生产者落地」。现状证据分三处：workflow `WorkflowEvent`（appendEvent，面板时间线）、两条平面 lifecycle 流 + DiagnosticRecord（ADR-0010/0011/0012）。v0.3 的停机出口要求「最低完整证据」——缺的是把一次 reconcile 内的 观察→守门→决策→动作→再观察 串成可追溯因果链的信封，而不是新总线。

## Decision

### 1. 信封是记录形状，不是新通道

`EventEnvelope` 是**判别式记录形状**，通过**既有 `appendEvent` 通道**追加进 workflow 事件流；失败与平面细节仍由 DiagnosticRecord / lifecycle 流承载，信封以 `correlationId` 关联（复用 ADR-0012 的 `source + correlationId` 模式）。禁止第四条持久化证据总线。

```
{ schemaVersion: 1, envelope: 'decision' | 'action' | 're-observe' | 'guard',
  causalId,            // 指向前一条信封（链头 = lease 发放）
  leaseId?: string,    // 自动来源时的 lease；人工动作为 null + grantId
  grantId?: string,    // 人工一次性授权 id（双模来源可分辨）
  at,
  // 判别式载荷：
  observed?: { factsRef },          // 观察：紧凑事实引用（派生键/契约指纹/基指纹），不复制大对象
  guard?: { rule, verdict },        // 守门：命中的规则与结论
  decided?: { action | 'wait' | 'pause' | 'complete' },
  acted?: { action, result: 'ok' | 'failed', detailRef },  // detailRef 指向动作结果/诊断
  verified?: { basisFingerprint } } // 再观察：消耗前基校验结论
```

### 2. 因果链单元与真实生产者

一次 reconcile tick 产生：`verified(基校验) → guard(规则判定) → decided(决策) → acted(若有动作) → 下一 tick 的 re-observe`。v0.3 的真实生产者恰是 ADR-0014 的新机器：

| 生产者 | 信封 |
|---|---|
| lease 发放（人工授权仪式） | 链头：`decision(lease-issued)`，绑 basisFingerprint |
| 消耗前基校验 | `re-observe(verified)` 或失败 → `guard(R4)` |
| Loop Guard 求值 | `guard(verdict)`——R1–R6 每次求值留痕，含 proceed（空转审计需要「为什么不停」与「为什么停」同样可查） |
| 动作派发（lease 来源） | `action(acted)`，consumption 记录并入 |
| 停机/暂停 | `decision(pause)` + 触发规则 + 下一步提示 |
| 人工动作（手动模式） | `action`（grantId 来源）——双模一致性要求人工路径同样入链 |

### 3. v0.3 范围：最小因果链，不做 v0.4

- **做**：单 lease 生命周期内的线性链；暂停出口的最低完整证据（ADR-0014 §3）由链尾片段构成；面板暂停视图按链解释「为什么停」。
- **不做**：跨任务协议审计、完整 Decision→Action→Re-observe 恢复重放（v0.4）、模型化 Runtime Observer（v0.6）。信封不承担恢复执行语义，只承担可追溯性。

### 4. 消费者（概念预算）

| 字段/概念 | 消费者 |
|---|---|
| causalId 链 | 面板暂停视图（按链解释）、guard R2/R3（读自身既往判定构造连续性）、事后审计 |
| guard.verdict（含 proceed） | 空转审计、面板「为什么没停」 |
| leaseId/grantId 来源字段 | 双模一致性验证、面板来源展示 |
| observed.factsRef（引用不复制） | 链解释时定位事实快照；大对象留在原处（平面/契约存储） |

无消费者的字段不得进入 schemaVersion 1。

## Required Verification

- 链完整性：一次自动轮次产生的信封序列可从链头走到链尾，causalId 无断链；进程重启后链仍完整（持久化即 workflow 事件）。
- 双模：同一动作在人工/lease 两来源下信封形状一致、仅来源字段不同。
- guard proceed 留痕：R1–R6 每次求值（含放行）都有记录。
- 基漂移场景：verified 失败 → guard(R4) → pause 的链尾即暂停出口证据。
- 概念预算测试：信封不复制平面/诊断大对象（factsRef 引用制）。

## Consequences

- 正：暂停证据从「散落注释」升级为可追溯因果链；空转可审计（含放行理由）；双模来源机器可分辨。
- 负：每轮 reconcile 追加 2–4 条事件记录，workflow.json 增长加快（轮次有上限 + 事件已随 workflow 持久化，接受）。
- 中性：完整重放/恢复、跨任务审计明确推 v0.4+。

## Alternatives Considered

- 新建独立事件总线持久化信封：拒绝——第四总线违反概念预算与 ADR-0012 关联模式。
- 信封复制完整事实快照：拒绝——引用制（factsRef）；复制即状态双写。
- 仅在停机时补写因果链：拒绝——proceed 也留痕是空转审计的前置条件，事后补写不可信。

## References

- roadmap：v0.3 行、「v0.2 不迁移 WorkflowEvent，不建完整自主决策事件总包」
- 现状通道：`src/infra/state.ts` appendEvent / WorkflowEvent、`src/infra/diagnostic-record.ts`、gateway/remote-git lifecycle
