# ADR-0010：GitHub REST Gateway 的准入调度与生命周期

> Status: Accepted | Date: 2026-08-31 | Refines: [ADR-0007](0007-three-git-github-access-planes.md)

## Context

ADR-0007 决定建立 GitHub REST Gateway，但没有决定一次 Controller 请求如何从声明走到缓存、合并、排队、执行、失效、回读和结算。Issue #131 因而曾在只有目标、计量口径和验收标准、没有算法与所有权设计的情况下进入 Coding；实现和 Review 被迫在代码中逐步发明计数器、证据结构与关闭语义。

不同 worktree 可能使用同一 GitHub 凭证读取同一资源；它们应共享预算和安全读取，又必须保留各自的调用归属。`git fetch` 等 Remote Git 操作不消耗 GitHub API bucket，不能与 GitHub 请求共用一个调度器。读取、写入和写后回读即使都由 `gh` 发起，也具有不同的缓存、重试和确认语义。

## Decision

### 1. 一个凭证作用域一个进程内所有者

同一 ClickVibe Controller 进程中，`providerInstance + credentialScopeId` 唯一确定一个 Gateway runtime。它拥有队列、缓存、in-flight 表、失效 generation、rate-limit 预算和 evidence writer；worktree/Work Item 只是调用归属，不拥有 Gateway。

`credentialScopeId` 由 GitHub adapter 从宿主认证上下文生成不透明 identity，不由业务调用者填写，也不得包含 token。若宿主无法安全区分两个 credential，v0.2 必须保守地把它们归为同一 scope（少复用可以，拆开同一预算不可以）。

Controller 重启后不恢复旧队列、缓存或预算。排队读取以 `interrupted` 结束并由调用方重新申请；已经派发但结果不确定的写入只能回读，不得自动重放。v0.2 不协调多个独立进程对同一凭证的使用。

### 2. 类型化申请代替命令猜测

Controller 提交类型化 GitHub operation、资源作用域、`critical | normal`、`cache-ok | upstream-confirmed`、deadline 和有限成本梯度。中央 operation policy 决定 HTTP 计划、最低一致性、是否可 join、受影响资源、重试规则和写后成功谓词。调用者不能把写入声明成可缓存读取，也不能降低关键门禁的一致性。

Gateway 不接收任意 `gh ...` 字符串。Agent-owned `gh` 保持 ADR-0007 的排除边界。

### 3. 一条准入状态机

安全读取依次经过 cache、singleflight、预算准入和排队；写入跳过普通缓存/singleflight，取得受影响资源的独占 lease 后执行。调度器按凭证总并发、单仓库并发、两级优先级、normal aging 和仓库轮转选择可执行 step。HTTP step 一旦派发不抢占；分页每页结算并重新入队。

预算 unknown 时每个凭证只保守放行少量探测 step；每个响应按实际 bucket 更新 remaining/reset。已知不足时，只有 reset 不晚于 deadline 才继续排队，否则返回带 `retryAt` 的限流结果。critical 只改变顺序，不绕过真实 primary/secondary limit。

### 4. 两种读取一致性

`cache-ok` 可复用未过期且 generation 匹配的 Observation；`upstream-confirmed` 必须在申请后收到 GitHub 响应，合法的条件请求 `304` 可以确认旧 Observation 仍有效。merge、Review、exact HEAD、契约门禁和写后回读由 operation policy 强制使用后者。

同一凭证、资源、规范化参数和兼容一致性的安全读取可跨 worktree join。高优先级 follower 可提升尚未派发的 leader；运行中的 step 不被抢占。缓存仍是 Observation 的复用机制，不成为 GitHub 事实源。

### 5. 写入是一个确认事务

写 operation 在同一资源 lease 内执行：持久化“准备派发且只能回读恢复”的 attempt marker → 必要的上游前置确认 → 恰好一次写尝试 → generation 失效 → 恰好一次权威回读 → 谓词比较 → `confirmed | failed | unknown`。显式拒绝可判 failed；传输中断、回读失败或事实不匹配均不得假定成功。非幂等写禁止自动重放。attempt marker 属于调用方 workflow/action 状态，不是持久化 Gateway 队列；Controller 重启后只恢复 readback。

### 6. 生命周期事件是唯一计量来源

每个 logical request 只有一条由 Gateway 产生的生命周期流：declared、cache-hit/joined/queued、dispatched、upstream-settled、invalidated/readback-settled、terminal。#133 的 logical、hit、join、execution、wait、failure、rate consumption 和 write-readback 从该流派生，不建立平行 counters/records。

Gateway 拥有异步 evidence writer，并在 `close()` 时停止准入、结算排队/运行请求、写 terminal 事件后 flush。业务能否推进由 workflow 正式状态回答；diagnostics 不承担业务提交。凭证、Authorization 和写入正文不得落盘，原始响应按 ArtifactRef 脱敏保存。

### 7. 迁移由类型边界和机器门禁共同收口

Slice A 引入 operation policy、Gateway runtime 和读取迁移；现有 Controller 直写只能留在具名临时 allowlist。Slice B 迁移全部写入并删除 allowlist。CI 的 GitHub-access 门禁拒绝 Gateway adapter 与明确 Agent prompt 之外新增 `gh api/issue/pr` 构造；最终 Controller 直接 `gh` 路径必须为零。

## Consequences

### Positive

- 算法和数据结构互相约束：所有计量都来自真实状态迁移，不能再用只被测试读取的容器冒充交付。
- 跨 worktree 复用 GitHub 事实，同时保留调用者归属；慢仓库不会占满全部凭证执行槽。
- 写入的不确定性显式成为 unknown，不靠重试制造重复评论、审批或合并。
- evidence writer 的关闭属于 Gateway 生命周期，不再由测试枚举目录猜测后台写入。

### Negative

- 进程重启会放弃排队请求，多个 Controller 进程仍可能共同消耗同一外部凭证。
- operation policy 必须枚举 Controller operation；新增 GitHub 行为需要先登记语义。
- 分页逐页调度和资源 lease 增加了确定性的调度状态，需要交错测试而非只测顺序结果。

### Neutral

- 并发数、TTL、aging 时间和成本梯度的数值不在 ADR 中拍定；实现必须用 #133 的冻结场景确定并记录。
- v0.2 使用最小 Gateway 生命周期记录，不提前复制 v0.3 的完整 EventEnvelope。

## Failure Modes

- **预算未知**：限流字段保持 unknown，以保守并发探测；禁止记零或伪造 core bucket。
- **leader 失败**：所有 follower 得到同一上游结算，但保留各自 logical terminal；不得丢失 join 归属。
- **写响应丢失**：不重写，失效后回读；无法证明预期事实即 unknown。
- **关闭与新申请竞争**：`close()` 原子关闭准入；关闭后申请立即 rejected，已登记请求必须有 terminal。
- **关闭超时后迟到响应**：request/owner generation 对 terminal 与 cache publish 做 fencing；迟到响应只能追加 late diagnostic，不能二次 terminal 或改写业务结果。
- **credential 切换**：新 credential generation 使用新 Gateway owner；旧 owner 进入 close，缓存和预算不得跨代复用。

## Alternatives Considered

- **在现有 250ms lane、缓存和 singleflight 外再包一层 scheduler**：拒绝；会留下两个执行与计量应答源。
- **全局 Git/gh 加权队列**：拒绝；混淆三个访问平面的成本与一致性边界。
- **持久化或独立 daemon 调度器**：v0.2 拒绝；恢复非幂等写需要租约和去重协议，超过当前问题。
- **任意整数权重**：拒绝；成本、优先级、可合并性和副作用不是一个标量。
- **每个调用方自行选择 TTL/force/retry**：拒绝；关键门禁与写回读会再次出现多个事实应答源。
- **shell 层拦截全部 `gh`**：拒绝；会误伤 Agent-owned 调用且无法可靠解释复合命令。

## References

- [Issue #131 完整设计](../../plans/2026-08-31-issue-131-github-gateway-design.md)
- [ADR-0002：权威事实与缓存边界](0002-authoritative-facts-and-cache.md)
- [ADR-0007：Git 与 GitHub 三访问平面](0007-three-git-github-access-planes.md)
- [v0.2 access baseline](../../baselines/v0.2-access-baseline.md)
- [可观测性与复盘](../observability.md)
