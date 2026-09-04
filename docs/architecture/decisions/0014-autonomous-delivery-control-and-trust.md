# ADR-0014：自主交付控制与信任模型——一条流水线、两种授权来源与确定性停机

> Status: Accepted | Date: 2026-09-04 | Issue: #168（v0.3.0） | 落实: [ADR-0004](0004-policy-controlled-autonomous-delivery.md)、[ADR-0008](0008-deterministic-loop-guard-and-optional-runtime-observer.md) | 地基: [ADR-0012](0012-work-item-contract-canonicalization-and-evidence.md) 契约指纹 | Related: [ADR-0015](0015-event-envelope-causal-chain.md)

## Context

v0.2 终局后单 Work Item 仍需逐步人工授权；`/auto` 循环已存在且动作全部与手动共用后端 handler，但授权、策略、停机三件事是隐式的：`AutoRunConfig` 散落在启动载荷里、机器没有可持有的权限凭证、空转/振荡靠循环内参数兜底。本 ADR 把既有事实显式化为四个命名概念并补齐缺口，使「交付一个 Issue 后可以离开」成为可验证行为。

## Decision

### 0. 宪法条款：一条流水线、两种授权来源

动作层（`startDevelop` / `createPullRequest` / `startReview` / `resumeDevelop` / `syncWorktree` / `mergeAndCleanup`）不接受「自动专用路径」。每个动作入口只接受两种凭证之一：

- **人工一次性授权**（现有机制，原样保留）：人点按钮/命令，一次性、短时效；
- **CapabilityLease**（本 ADR 新增）：机器持有的限时凭证。

两者过**同一套门禁**（review 绑定、基线等价、CI、契约指纹、合并门禁），产生**同一格式的证据**（见 ADR-0015，每条记录授权来源）。禁止出现第二条「自动专用流水线」；发现即返工。

### 1. 最小 Policy（v1）

`DeliveryPolicy` 是版本化工件而非散落参数：

```
{ schemaVersion: 1, policyId, policyFingerprint,
  autoMerge, devAgent, reviewAgent, maxRounds, budgetHours,
  createdAt, authorizedBy: 'human-grant:<id>' }
```

- v1 存储位置：随启动授权快照进 workflow 记录（现状位置，命名为工件并加指纹）；项目级默认与完整版本化治理属 v0.7。
- 默认手动：`autoMerge=false` 且不启动 lease 即纯手动（`decideAutoRun` 缺省 `manual` 的现状语义不变）。
- 消费者：lease 校验（动作白名单由 policy 推导）、Loop Guard（轮次/预算）、面板展示。
- `policyFingerprint` 进入 DeliveryBasis；policy 变更 = 基变更 = lease 作废。

### 2. DeliveryBasis（命名凭证）

收口既有三要素为一个显式凭证并定义失效规则：

```
{ basisFingerprint,
  contractFingerprint (wic1_…, ADR-0012),
  policyFingerprint,
  frozenBaseline (baseRef @ sha),
  reviewBinding?: { reviewedSha, reviewFingerprint } }
```

失效规则（任一命中 → lease 作废，自动推进停止）：

| 变化 | 后果 |
|---|---|
| 契约指纹变化 | **永远要求新的人工授权**——绝不自动续跑（`startAutoRun` 现有的启动期校验推广到每次 lease 消耗前） |
| policy / 基线变化 | lease 作废，进入 `human-required`，可由人基于新基快速重开 |
| review 绑定失效 | 按既有 review 失效规则，禁止带旧结论合并（现状不变，纳入凭证） |

校验点：每次 reconcile 在派发动作**之前**重导当前基指纹，不匹配即作废——不靠启动时一次性检查。

### 3. WorkflowControlState（控制视角状态机）

从 `AutoRunState`（status/pausedReason/step/rounds/unresolved）演进为控制视角的显式状态机：

```
manual ──人工授权──▶ leased(issuing) ──▶ leased(idle|acting|waiting)
   ▲                    │ guard stop / 失效 / 预算尽 / 失败×2
   │                    ▼
   └──人工重新授权── paused(human-required) 
leased(*) ──合并完成/issue 关闭──▶ completed
```

- `paused(human-required)` 最小暂停出口（roadmap v0.3 边界）：**持久化**暂停原因 + **最低完整证据**（基快照、最后决策、触发规则的原始失败文本、命中的 guard 规则）+ **明确下一步**（人需要做什么）。现状 `pauseAutoRun` 已持久化 reason 与部分证据，缺口是结构化「命中规则 + 下一步」。
- 恢复 = 人重新授权 = 基于当前观察发放新 lease（对 `controller-error` 的重挂机制保留，作为暂停态内部的自愈通道）。

### 4. CapabilityLease

```
{ leaseId, basisFingerprint,
  actions: 白名单（7 种 NextAction 按 policy 过滤；autoMerge=false 则不含 merge/cleanup）,
  issuedAt, deadline(=budget), roundsUsed/roundsMax,
  status: active | consumed | void | expired,
  issuedBy: 'human-grant:<id>' }
```

- **发放**：唯一入口是人工授权绑基（`startAutoRun` 即发放仪式——它已校验契约指纹并保存 contract，本 ADR 将其扩展为绑定完整 basis）。
- **消耗**：每个自动动作 = 一次消耗，记录 `{leaseId, action, at, result}` 为 workflow 事件（授权来源可追溯——双模一致性的证据面）。
- **吊销/过期**：用户 stop、基失效、guard 停机、deadline（现有 deadline 武装机制保留）。
- **实现边界**：不引入新锁机制——并发安全沿用 workflow 持久层 revision/CAS 与现有 reconcile 串行化。

### 5. 纯规则 Loop Guard

独立纯函数 `evaluateLoopGuard(input) → proceed | backoff(ms) | stop(rule, humanRequired)`，在**每次 reconcile 派发动作之前**求值，求值结果本身入因果链（ADR-0015）。v0.3 冻结规则集：

| 规则 | 输入 | 结论 |
|---|---|---|
| R1 预算/轮次耗尽 | deadline、roundsUsed/maxRounds | stop（现状形式化） |
| R2 同类失败连续 2 次 | 连续两次同 PausedReason 分类的自动可重试失败（conflict/controller-error 类） | stop，human-required（新增红线） |
| R3 review 振荡 | 同一未解决 issue 文本连续 ≥2 轮复现 | stop，human-required（新增） |
| R4 契约漂移 | 消耗前基校验失败 | lease 作废 + stop，human-required（新增，永不自动重启） |
| R5 瞬时可重试 | rate-limit（经 Gateway 断路器）、sync 冲突（现场已保留） | backoff 有界重试（现状形式化：conflict 自动转交 agent 的路径保留） |
| R6 issue 关闭 | issueState | complete（现状） |

Guard **只约束自动来源**：人工动作永不被 R1–R4 拦截（同样过门禁、留证据）。规则从 `decideAutoRun` 的内嵌检查中提取为独立模块（`auto-run-policy.ts` 同层纯函数），纯逻辑测试无沙箱依赖。

## Algorithm ↔ Data Structure Cross-check

| 算法/迁移 | 读 | 写 | owner/串行点 | 失败结果 |
|---|---|---|---|---|
| lease 发放（人工授权） | 当前契约观察 + policy | lease 记录（workflow 元数据） | 人工授权 + workflow CAS | 基不匹配 → 拒绝启动 |
| 消耗前基校验 | 契约指纹、基线、review 绑定 | 无（只读判定） | reconcile 串行点 | 不匹配 → lease 作废 + human-required |
| guard 求值 | rounds、失败序列、振荡、预算 | 判定记录（事件） | reconcile 串行点 | stop → paused(human-required) |
| 动作派发（双来源） | lease 或人工授权 | 动作结果 + 消耗记录（事件） | 动作层（现有） | 失败按 R2/R5 分类 |

| 概念 | 生产者 | 生产消费者 | 生命周期 |
|---|---|---|---|
| DeliveryPolicy | 人工授权时的快照 | lease 校验、guard、面板 | 随 lease 存续，指纹入基 |
| DeliveryBasis | 发放时组装 + 消耗前重导 | lease 校验、guard R4 | 随 lease 存续 |
| CapabilityLease | 人工授权仪式 | reconcile 派发、面板来源展示 | issue→consumed/void/expired |
| ControlState | reconcile/pause/complete | derive、面板、恢复入口 | workflow 生命周期 |

## Required Verification

- lease：无授权不发；基漂移后任一动作被拒且 lease=void；autoMerge=false 时 merge/cleanup 不在白名单。
- guard：R1–R6 各一测（纯函数）；R2 用连续两次同因失败构造；人工路径不被 R1–R4 拦截的反向测试。
- 双模一致性：同一动作分别以人工授权与 lease 触发，门禁与证据格式一致、来源字段不同。
- 暂停出口：paused 记录含原因+证据+下一步三元组，进程重启后仍完整。
- 交错/崩溃：消耗记录与动作副作用的写入顺序（先副作用后记账 vs 反之）在 checkpoint 注入下可恢复。

## Consequences

- 正：机器获得有凭证、可吊销、可追溯的自主权；「走不开」的根因（逐次人点）被 lease 替代；停机红线确定性化。
- 负：每次消耗前基校验增加每轮观察成本（复用 v0.2 平面缓存，实测约束在验收）；四个新概念各有消费者，评审按 #144 概念预算纪律把关。
- 中性：项目级 policy、授权快照审计推 v0.7。

## Alternatives Considered

- 自动专用流水线：拒绝——门禁分叉即绕过面。
- lease 绑定时钟 TTL 而非预算 deadline：拒绝——deadline 已存在且可持久化恢复。
- guard 内嵌在 decideAutoRun：拒绝——停机规则必须独立可枚举、可测试、可在面板解释。

## References

- roadmap v0.3.0 与「v0.3 最小暂停出口」；#111/#107 现场教训（controller-error 重挂、sync 冲突自动转交）
- 现状实现：`src/workflow/auto-run.ts`（reconcile 串行、startAutoRun 契约校验）、`auto-run-policy.ts`、`auto-run-recovery.ts`
