# ClickVibe v0.2 核心数据契约

> Status: Accepted | Parent: [Canonical Domain Model](canonical-domain-model.md) | Decision: [ADR-0006](decisions/0006-canonical-domain-model-and-contracts.md)

本文中的 TypeScript 是持久化/wire 语义草图，不承诺物理文件位置，也不等于立即修改公开 API。每个字段必须先有唯一语义，再进入实现。

## 通用规则

1. 持久化 identity、SHA、fingerprint、event id、run id 均使用字符串；GitHub 数字编号只在 Adapter 内验证/转换。
2. 可独立持久化或作为 API 根对象的记录包含 `schemaVersion`；嵌套 value object 和进程内纯推导值无需滥加版本。
3. SHA 保存完整值，短 SHA 仅用于展示。
4. 时间戳使用 UTC ISO-8601，只用于审计；并发顺序使用 revision/generation/sequence。
5. `unknown` 是明确状态；缺字段不能自动等价为 false、成功、终止或空集合。
6. 大型 prompt、日志、diff 和原始响应保存为 ArtifactRef，不复制进每个状态对象。
7. 所有哈希使用明确的 canonical serialization 与算法版本；字段顺序、空值和换行规范必须固定。

## 1. 平台与 Work Item 身份

```ts
interface WorkItemIdentity {
  provider: string
  instance: string
  container: string
  id: string
}

interface WorkItemRef {
  identity: WorkItemIdentity
  displayKey: string
  url: string
}
```

### 字段白话解释

| 字段 | 说人话 | GitHub 示例 | 用途 |
|---|---|---|---|
| `provider` | 这是哪一种平台 | `github` | 选择对应 Adapter；不能靠 URL 猜 |
| `instance` | 平台部署在哪里 | `github.com` | 区分公有 GitHub 与 GitHub Enterprise 等实例 |
| `container` | 工单属于哪个项目/仓库/团队 | `ai-daming/clickvibe` | 给本地编号提供作用域；不同容器都可以有 `131` |
| `id` | 工单在容器里的 provider-native 标识 | `"131"` | 核心统一为 string；Jira 可用 `ENG-482`，其他平台可用 UUID |
| `displayKey` | 给人看的编号 | `#131` | 只负责 UI/评论，不参与全局身份判断 |
| `url` | 当前如何打开它 | GitHub Issue URL | 是可变 locator；改名/路由变化不能改变逻辑身份 |

完整身份是四元组，不是裸 `id`。当前 GitHub Adapter 继续接受数字 Issue，只在边界验证 `id` 是否为正整数字符串。

## 2. Project Binding

```ts
interface ProjectBinding {
  schemaVersion: 1
  bindingId: string
  container: {
    provider: string
    instance: string
    id: string
  }
  repository: {
    repositoryId: string
    localPath: string
    primaryRemote: string
  }
}
```

| 字段 | 说人话 |
|---|---|
| `bindingId` | ClickVibe 给这条“外部项目 ↔ 本地仓库”关系的稳定 ID |
| `container` | GitHub repo、GitLab project、Jira project 等外部容器 |
| `repositoryId` | ClickVibe 识别本地 Git 仓库的稳定 ID，不等于当前 path |
| `localPath` | 这台机器现在从哪里访问仓库；换机器或移动目录可变化 |
| `primaryRemote` | 远端协调默认使用哪个 Git remote，通常是 `origin` |

`ProjectBinding` 是机器/部署配置，不是 Git/GitHub 事实。一个外部项目没有本地 binding 时仍可只读展示，但不能启动需要 worktree 的 Run。

## 3. WorkflowIdentity

```ts
interface WorkflowIdentity {
  workItem: WorkItemIdentity
}
```

v0.2 以 Work Item 为交付单元，一个 Work Item 对应一个 Workflow。重复开发、Review、重开、恢复和 Observer 介入由 Run、round 与 generation 表达。

如果未来同一 Work Item 需要同时驱动多个独立交付，必须新增 Delivery Slice；不能在 `WorkflowIdentity` 上偷偷拼 branch 或 run id。

## 4. WorkItemContractSnapshot

```ts
interface WorkItemContractSnapshot {
  schemaVersion: 1
  workItem: WorkItemIdentity
  sourceVersion: string
  goal: string
  acceptanceCriteria: string[]
  nonGoals: string[]
  dependencies: WorkItemIdentity[]
  architectureImpact: 'L0' | 'L1' | 'L2' | 'L3' | 'unknown'
  fingerprint: string
  capturedAt: string
  rawArtifact: ArtifactRef
}
```

| 字段 | 说人话 |
|---|---|
| `sourceVersion` | Provider 告诉我们的版本标识，例如 `updated_at`/etag；用于判断是否需要重抓 |
| `goal` | 这张工单最终要改变什么 |
| `acceptanceCriteria` | 怎样算交付完成 |
| `nonGoals` | 本次明确不做什么，防止 Agent 自行扩张范围 |
| `dependencies` | 哪些 Work Item 未完成时不能启动或交付 |
| `architectureImpact` | 是否需要先做架构设计 |
| `fingerprint` | 对规范化合同计算的指纹；需求变化时让旧 Review/Observer 失效 |
| `rawArtifact` | 原始 Issue/评论快照的本地证据引用；摘要不能替代原文 |

`fingerprint` 不应直接对未规范化的 Markdown 原文计算，否则空格或排版变化会制造无意义失效。

## 5. DeliveryBasis

```ts
interface DeliveryBasis {
  workflow: WorkflowIdentity
  contract: {
    fingerprint: string
  }
  architecture: {
    revision: string
  }
  baseline: {
    ref: string
    sha: string
  }
  head: {
    sha: string
  }
}
```

整个结构说人话就是：

> 对这张工单，按照这版需求和这版架构，以这条 baseline 的这个精确位置为基准，判断这一个 exact HEAD。

### 每个字段的含义

| 字段 | 说人话 | 干什么用 |
|---|---|---|
| `workflow` | 这次开发/Review/合并到底属于哪张工单 | 把 Run、Review、Observer、日志和交付结果串在一起 |
| `contract.fingerprint` | 施工依据的是哪一版需求 | Issue 目标/验收/依赖变化后，让旧结论自动失效 |
| `architecture.revision` | Agent 按哪一版系统架构和工程规则施工 | 判断代码是否遵循当前 Accepted ADR；通常是架构 baseline 的完整 Git SHA |
| `baseline.ref` | 这条开发分支应该持续跟随哪条主线 | 例如 `refs/remotes/origin/main`；用于 fetch/sync/PR base 判断 |
| `baseline.sha` | 本次判断时，那条主线精确在哪一个 commit | ref 会移动，SHA 冻结当时位置；用于判断落后、冲突和 diff 基准 |
| `head.sha` | 本次 Coding、Review、Observer 或 merge 针对哪份代码 | HEAD 变化后旧 Review 失效；merge 必须匹配通过结论的 exact HEAD |

`baseline.ref` 是“路名”，`baseline.sha` 是“当时这条路走到了哪里”，`head.sha` 是“这次要验收的成品是哪一份”。

## 6. Observation、Evidence 与 Cache

```ts
interface Observation<T> {
  schemaVersion: 1
  observationId: string
  source: 'local-git' | 'remote-git' | 'provider' | 'dsh' | 'clickvibe'
  subject: string
  observedAt: string
  sourceVersion?: string
  fingerprint: string
  value: T | { state: 'unknown'; errorRef: string }
}

interface ArtifactRef {
  artifactId: string
  kind: 'issue-snapshot' | 'log' | 'diff' | 'provider-response' | 'model-output' | 'diagnostic'
  path: string
  contentHash: string
  redaction: 'none' | 'applied'
}

interface CacheEntry<T> {
  schemaVersion: 1
  cacheKey: string
  observation: Observation<T>
  storedAt: string
  expiresAt: string | null
  validator: string | null
}

interface ObservationBundle {
  schemaVersion: 1
  workflow: WorkflowIdentity
  observations: Observation<unknown>[]
  evidence: ArtifactRef[]
  completedAt: string
}
```

- **Fact** 是 Git/GitHub/DSH 外部世界当前真实状态。
- **Observation** 是 ClickVibe 某一时刻读到的结果。
- **Evidence/Artifact** 是支撑判断的不可变原始材料或引用。
- **Cache** 只是复用旧 Observation 的机制。
- **Projection** 是给 UI/查询使用的推导结果。

`expiresAt` 到期不表示事实为 false，只表示需要重新观察。关键门禁可以绕过普通 TTL，CacheEntry 不能直接授权动作。

## 7. AutomationPolicySnapshot

```ts
interface AutomationPolicySnapshot {
  schemaVersion: 1
  policyVersion: string
  workflow: WorkflowIdentity
  allowedActions: Array<'develop' | 'review' | 'sync' | 'push' | 'create-pr' | 'merge' | 'cleanup' | 'observe'>
  mergeMode: 'manual' | 'automatic'
  limits: {
    maxReviewRounds: number
    maxObserverInterventions: number
    deadline: string
  }
  agentPolicy: {
    develop: string
    review: string
    observer: string | null
  }
}
```

PolicySnapshot 是“这一次自动化被允许做到哪里”的冻结规则，不是当前运行进度。`round/step/active run/generation` 属于 WorkflowControlState，不能混入 Policy。

## 8. WorkflowControlState、CapabilityLease 与 Run

```ts
type RunKind = 'develop' | 'review' | 'sync' | 'observer' | 'merge' | 'cleanup'

interface WorkflowControlState {
  schemaVersion: 1
  workflow: WorkflowIdentity
  revision: number
  generation: number
  automationMode: 'enabled' | 'paused' | 'human-required'
  round: number
  step: number
  activeRunId: string | null
  lastDecisionId: string | null
  updatedAt: string
}

interface CapabilityLease {
  schemaVersion: 1
  leaseId: string
  workflow: WorkflowIdentity
  generation: number
  holder: string
  runId: string
  kind: RunKind
  scope: {
    repositoryId: string
    workItem: WorkItemIdentity
    branch: string | null
    allowedActions: string[]
  }
  issuedAt: string
  expiresAt: string | null
}

interface RunRecord {
  schemaVersion: 1
  runId: string
  workflow: WorkflowIdentity
  generation: number
  kind: RunKind
  basis: DeliveryBasis
  taskId: string
  hostJobId: string | null
  session: { runtime: string; sessionId: string } | null
  leaseId: string
  status: 'claimed' | 'running' | 'settled'
  startedAt: string
  settledAt: string | null
}

interface RunOutcome {
  schemaVersion: 1
  runId: string
  generation: number
  status: 'succeeded' | 'failed' | 'stopped' | 'timed-out' | 'unknown'
  outputArtifact: ArtifactRef | null
  errorRef: string | null
}
```

WorkflowControlState 是命令域原子写入的最小当前状态，不缓存 Git/GitHub 事实，也不保存 `merged/reviewable` 这类应由事实推导的阶段。`automationMode` 只表示控制器是否还能自动推进；`activeRunId` 只回答“谁持有当前运行资格”，任务是否真的存活仍需观察 DSH/进程事实。

| 概念 | 说人话 |
|---|---|
| `generation` | 这是第几代有写资格的任务；新一代出现后旧回调失效 |
| `revision` | 共享状态当前是第几个 CAS 版本；防止两个写入互相覆盖 |
| `sequence` | 事件在日志里排第几个；用于审计顺序 |
| `round` | 完成了几次 Coding→Review 业务闭环 |
| `step` | Auto-run 触发了多少个动作 |

五者都可以是 number，但绝不能互换。

## 9. ReviewConclusion

```ts
interface ReviewFinding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  theme: string
  summary: string
  evidence: ArtifactRef[]
}

interface ReviewConclusion {
  schemaVersion: 1
  conclusionId: string
  workflow: WorkflowIdentity
  basis: DeliveryBasis
  verdict: 'pass' | 'fix-these' | 'stop-and-redesign'
  findings: ReviewFinding[]
  reviewer: { runtime: string; agent: string; sessionId: string }
  completedAt: string
  rawOutput: ArtifactRef
}
```

`passed + issues[]` 不足以驱动 0.2。Finding 必须有稳定 id、severity、theme 和证据，才能被 Rework、Loop Guard、Observer、merge gate 和复盘共同消费。

ReviewConclusion 只对自己的 DeliveryBasis 有效；当前 contract、architecture、baseline 或 head 变化后，它仍是历史证据，但不再授权 merge。

## 10. Decision、ActionResult 与 DeliveryRecord

```ts
interface DecisionRecord {
  schemaVersion: 1
  decisionId: string
  workflow: WorkflowIdentity
  basis: DeliveryBasis
  policyVersion: string
  evidenceIds: string[]
  action: 'wait' | 'develop' | 'review' | 'rework' | 'sync' | 'observe' | 'merge' | 'cleanup' | 'pause'
  reasonCodes: string[]
  decidedAt: string
}

interface ActionResult {
  schemaVersion: 1
  decisionId: string
  status: 'succeeded' | 'failed' | 'unknown'
  externalRefs: string[]
  evidenceIds: string[]
  errorRef: string | null
  completedAt: string
}

interface DeliveryRecord {
  schemaVersion: 1
  workflow: WorkflowIdentity
  basis: DeliveryBasis
  providerChangeRef: string
  status: 'merged' | 'cleanup-pending' | 'archived'
  mergedAt: string
  cleanup: {
    worktree: boolean
    localBranch: boolean
    remoteBranch: boolean
    workItem: boolean
  }
  lastErrorRef: string | null
}
```

DecisionRecord 回答“为什么做”；Run/外部调用回答“怎么做”；ActionResult 回答“重新观察后发生了什么”。三者不能压缩成一个 `ok: boolean`。

GitHub 返回 merge success 不能直接写 `DeliveryRecord.status=merged`；必须回读 provider 的 MERGED 状态和目标 ref。

## 11. LoopControl 与 ObserverResult

Runtime Observer 的详细结构见 [循环监督与 Observer](observer-intervention.md)。它必须复用本文的 WorkflowIdentity、DeliveryBasis、ReviewConclusion、ArtifactRef、generation 与 EventEnvelope，不再建立第二套 SHA/证据模型。

ObserverResult 是诊断与下一轮指令，不是 ReviewConclusion、ActionResult 或 merge 授权。

## 12. EventEnvelope 与 DiagnosticRecord

```ts
interface EventEnvelope<TType extends string, TPayload> {
  schemaVersion: 1
  eventId: string
  type: TType
  workflow: WorkflowIdentity
  sequence: number
  generation: number
  correlationId: string
  causationId: string | null
  occurredAt: string
  actor: 'controller' | 'coding-agent' | 'review-agent' | 'runtime-observer' | 'protocol-observer' | 'user'
  basis: DeliveryBasis | null
  payload: TPayload
}

interface DiagnosticRecord {
  schemaVersion: 1
  diagnosticId: string
  workflow: WorkflowIdentity | null
  operation: string
  classification: string
  message: string
  stack: string | null
  rawArtifact: ArtifactRef | null
  occurredAt: string
}
```

目标事件是判别式 union，而不是继续向同一个对象追加可选字段：

```ts
type WorkflowEvent =
  | EventEnvelope<'workflow.observed', ObservationBundle>
  | EventEnvelope<'decision.made', DecisionRecord>
  | EventEnvelope<'run.started', RunRecord>
  | EventEnvelope<'run.settled', RunOutcome>
  | EventEnvelope<'review.completed', ReviewConclusion>
  | EventEnvelope<'observer.completed', ObserverResult> // 定义见 observer-intervention.md
  | EventEnvelope<'delivery.merged', DeliveryRecord>
```

事件用于审计与投影，不意味着所有当前状态都必须从零重放。WorkflowControlState 仍由串行命令域原子持久化，事件追加失败必须作为明确错误处理，不能静默丢失因果链。

## 13. Schema 演化规则

1. 只在持久化/wire 边界设置 schemaVersion；当前首版为 `1`。
2. 新增可选展示字段可以向前兼容；改变身份、权威、状态语义必须升级版本。
3. 每个版本提供显式、幂等迁移函数；迁移前备份，失败保留原文件并停止写入。
4. 旧记录读取后进入目标内存模型，但新写入只使用目标 schema，禁止长期双写。
5. 未知 event type 原样保留并跳过 Projection，不能删除或解释成成功。
6. Hash 输入包含 schema/canonicalization 版本，算法变化不会冒充相同 fingerprint。

## 14. v0.1 → v0.2 迁移映射

下表是“决定保留该资产时如何迁移”的映射，不是对全部 v0.1 内部结构的兼容承诺。实施前先把每类代码和持久数据标记为保留、重构、迁移、归档或废弃；废弃项必须说明理由、影响范围和备份位置。

| v0.1 字段/结构 | v0.2 目标 | 迁移规则 |
|---|---|---|
| `repoKey: owner/repo` | WorkItem `provider/instance/container` | 当前映射为 `github/github.com/repoKey` |
| Issue URL 中的 number | `WorkItemIdentity.id` | 转为十进制字符串；URL 保留为 locator |
| `IssueWorkflow.key` | WorkflowIdentity 的存储键 | 兼容读取旧 key；新 canonical key 包含 provider/instance/container/id |
| `worktree/branch` | ProjectBinding + Run scope/Projection | path 是 locator，不进入身份 |
| `baseRef` 拼接字符串 | `DeliveryBasis.baseline.ref/sha` | 能可靠解析才迁移；不完整则标记 unknown，禁止猜 |
| `issueSnapshot` | WorkItemContractSnapshot | 原文进入 ArtifactRef；缺 AC/Non-Goals 等按 legacy/unknown 处理 |
| dev/review task/session 字段 | RunRecord + CapabilityLease | 迁移当前引用；没有 generation 证据的旧 Run 不获得新写权限 |
| `reviewResult.passed/issues` | legacy ReviewConclusion | 缺 exact basis/theme/evidence 时只能展示，不能授权自动 merge |
| `autoRun` | AutomationPolicySnapshot + WorkflowControlState | 配置与进度拆分；旧状态保留原始 ArtifactRef |
| `WorkflowEvent` 可选字段对象 | 判别式 EventEnvelope | 按 kind 映射；无法判定的字段进入 legacy payload，不丢弃 |
| `stage` | Workflow Projection | 作为迁移提示，不提升为 Git/GitHub 事实 |

迁移完成标准不是“新类型能读取旧 JSON”，而是：旧记录不会获得比原来更多的权限，unknown 不被补成确定值，且新写入只有一个事实源。
