# 核心数据流

> Status: Accepted | Parent: [当前有效架构](../architecture.md)

## 主交付流

```mermaid
sequenceDiagram
  participant U as User / Policy
  participant C as ClickVibe
  participant G as Git + GitHub
  participant A as Agent
  participant E as Event Store

  U->>C: 选择 Issue / 启用自动策略
  C->>G: Observe Issue、refs、worktree、PR、Review、CI
  C->>C: 纯函数推导 next action
  C->>E: 记录观察摘要和决策
  C->>A: 任务契约 + baseline SHA + 架构上下文
  A->>G: 编码、测试、解决冲突、commit/push/PR 协作
  A-->>C: 结构化完成声明（不可信输入）
  C->>G: Re-observe 实际 HEAD、PR、Review、CI
  C->>E: 保存原始输出、验证证据和结果
  alt 满足策略与全部门禁
    C->>G: merge exact reviewed HEAD
    C->>G: 回读 MERGED 与目标 ref
  else 可恢复
    C->>A: 返工 / 同步 / 解决冲突
  else unknown、越权或不可安全收敛
    C->>E: 持久化暂停原因与人工下一动作
  end
```

这条目标流不要求新增“架构服务”。它通过现有 workflow、github、agent、infra 四层收敛职责：Observe 统一读取，Decide 保持纯函数，Apply 复用 use case，Verify 统一回读。

## 循环监督流

每次 Review 结论完成写后回读并持久化后，Controller 必须先评估循环健康度，不能直接把失败意见再次交给 Coding Agent：

```mermaid
sequenceDiagram
  participant R as Review Flow
  participant E as Workflow Event Store
  participant G as Loop Guard
  participant O as DSH Runtime Observer
  participant C as Auto-run Controller

  R->>E: review verdict + exact HEAD + theme + finding evidence
  E->>G: immutable loop evidence snapshot
  G->>G: pure policy evaluation
  alt 正在收敛
    G-->>C: continue-rework
  else 停滞或发散
    G-->>C: observe(trigger, evidenceHash)
    C->>E: observer.triggered；冻结普通 Coding/Review 推进
    C->>O: 专属只读会话 + 完整跨轮证据
    O-->>C: structured ObserverResult
    C->>E: observer.completed + sessionId + evidenceHash
    C->>C: 纯策略选择 redirect / redesign / human-required
  end
```

Loop Guard 只消费已经持久化的结构化事实；模型不决定自己何时被调用。Runtime Observer 的输入必须绑定 exact HEAD、Work Item 契约、架构 baseline 和完整 Review 历史。其输出是诊断证据与下一轮指令，不能覆盖 Git/GitHub/CI 事实或越过 merge 门禁。详细契约见 [循环监督与 Observer](observer-intervention.md)。

### Observer 结果的缓存边界

Observer 只允许按完整 `evidenceHash` 幂等复用。该哈希至少覆盖 Work Item 契约指纹、架构 baseline、各轮 exact HEAD、结构化 Review 结论和 Observer 策略版本。任一输入变化都必须重新运行；旧结果仍保留为历史证据，但不得决定当前动作。

## GitHub 读取与缓存

GitHub 请求统一经过 `src/github` 适配层。缓存只减少请求，不产生新的事实源：

| 数据 | 缓存策略 | 绕过/失效条件 |
|---|---|---|
| 仓库 Issue/PR 聚合 | 短 TTL + 并发请求合并 | 手动刷新、关键动作前强制读取 |
| 单 Issue/PR 详情 | 资源缓存；`updated_at` 未变时复用 | 对该资源写入成功后立即失效 |
| GitHub 限流状态 | 按账号/令牌的进程内熔断 | `Retry-After` 或 rate-limit reset 到期 |
| 合并与 Review 门禁事实 | 不依赖普通 TTL | 每次决策前强制读取 exact HEAD、契约和 GitHub 状态 |

写动作遵循：

```text
冻结目标与授权
→ 执行写入
→ 主动失效相关缓存
→ 回读 GitHub
→ 只有观察到预期事实才算成功
```

## 本地 Git 数据流

本地 Git 查询不进入 GitHub REST 缓存。一个刷新周期内可以生成不可变 `LocalGitSnapshot` 供多个纯函数消费，但下一次用户动作、任务完成、fetch/sync/merge 后必须重新采样。冲突现场是正式状态，不能通过 stash、reset 或删除 worktree 抹掉。

## 架构数据流

L2/L3 Issue 不能直接进入 Coding：

```text
业务 Issue
→ Architecture Impact
→ Design / ADR PR
→ 合入 baseline
→ Implementation Issue 绑定 baseline SHA
→ Coding / Review
```

这条链使并行 Agent 共享同一套慢变量，避免每个 Agent 各自发明事实源、缓存和权限模型。
