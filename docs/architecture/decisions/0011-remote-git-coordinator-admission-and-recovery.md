# ADR-0011：Remote Git Coordinator 的单飞、串行化与写恢复

> Status: Accepted | Date: 2026-09-02 | Baseline: `a342b9a14a65e880bcd57e89d035e73cc28d571d` | Refines: [ADR-0007](0007-three-git-github-access-planes.md)

## Context

ADR-0007 划出了 Local Git、Remote Git 和 GitHub REST 三个访问平面，并要求 Remote Git 按 `repositoryId + remote` 协调读取与修改；它没有决定 `fetch` 如何同时合并重复请求和参与写互斥、远端写在进程中断后如何恢复、各类写凭什么获得权限，以及失效和计量由谁拥有。

Issue #135 的 Q1–Q8 已确认以 `repoKey + remote` 作为 v0.2 运行时协调身份，接口保留 `repositoryId` 字段；收编 freshness 门；`ls-remote` 合并，`fetch`/`push` 排队；所有 push 必须权威回读；Coordinator 统一广播远端操作造成的 Local Git Snapshot 失效；只协调远端操作；并冻结 TTL、超时和等待数值。但这些决定仍不足以直接编码，因为以下交错没有唯一答案：

- 三个并发 `fetch upstream` 必须只执行一次并记录两次 join，同时该次真实 fetch 又必须和 push 互斥；
- push 已发出但响应丢失或进程退出时，重启不能靠重放猜测结果；
- workflow sync、PR 创建 push、baseline restore 和远端分支清理持有的权限材料不同；
- fetch/push 的结果可能未知，但它们仍可能已经改变 remote-tracking refs 或远端 refs，不能跳过失效与回读；
- #122 Local Git Snapshot、#131 GitHub REST Gateway 和本 Coordinator 都有观测需求，但不能再生出第三套平行计数器作为伪事实源。

本文中的术语首次出现时作如下约定：

- **singleflight（单飞）**：多个相同请求共享一次真实远端命令，每个调用者仍保留自己的请求结果和计量归属。
- **临界区**：同一 `repoKey + remote` 在同一时刻只允许一个会改变或确认远端相关事实的写序列进入的区域。
- **lease（租约）**：证明某个 workflow/action 当前仍拥有写权限、代次未变且目标未被别的动作接管的凭证。
- **force-with-lease**：只有远端 ref 仍等于调用者事先看到的 SHA 才允许强制更新；它不是无条件 force。
- **remote-tracking refs（远端跟踪引用）**：本地保存的 `refs/remotes/...` 快照，由 fetch 更新，但它们不是远端仓库本身。

## Decision

### 0. 与既有 ADR 的关系

- ADR-0001 决定本文只有在 Accepted 且合入 main 后才生效；Draft 不得被当作代码依据。
- ADR-0002 决定 Git refs 仍是事实源，flight、TTL、marker 和 lifecycle 都只是协调或证据。
- ADR-0003 要求 L3 先确定事实源、不变量、原子边界、失败、迁移和回滚；本文补齐这些设计，不代替后续 impl-gate。
- ADR-0004 要求副作用后重新观察再推进；本文把 push 后 dedicated readback 和 unknown fail-closed 固化为 Remote Git 版本。
- ADR-0005 已被废弃，只作为历史警示；本文不恢复其 Runtime Observer 驱动模型。
- ADR-0006 要求 domain 自有契约并限制预测性概念；attempt 归 caller action，本文也不复制 v0.3 CapabilityLease/EventEnvelope。
- ADR-0007 是本文直接细化的三平面边界；Remote Git 不借用 Local Git 或 GitHub REST 的执行器。
- ADR-0008 要求确定性安全不依赖 Observer；重启恢复由 marker + Git readback 完成。
- ADR-0009 禁止隐式状态升级；本文不设迁移 job、长期双写或无授权代次切换。
- ADR-0010 只提供 caller-owned marker、readback-only recovery 和 lifecycle 计量的已接受模式；本文不共享其 Gateway surface、queue、cache、credential scope 或事件对象。

### 1. 所有权和协调身份

同一 Controller 进程中，一个 active `repoKey + remote` 唯一对应一个 `RemoteGitOwner`。它拥有该 scope 的 mutation FIFO、compatible fetch flight、通用 `ls-remote` flight 和 lifecycle evidence sink。`repositoryId` 随请求和证据传递，但在另有 Accepted 决策前不参与 v0.2 的 key，也不得在运行中把同一 owner 静默换 key。

owner 是进程内协调器，不是 Git 事实源。远端 refs 仍由远端 Git 回答，remote-tracking refs 仍由本地 Git 回答；队列、flight、marker 和 evidence 只能说明访问过程，不能替代 ref 事实。

不同 scope 没有共享执行队列或全局互斥。A 仓库的慢 push 不得占住 B 仓库的 fetch。Controller 重启后 owner 冷启动，不恢复旧队列或 flight。

### 2. fetch 同时单飞并串行

`fetch` 采用“逻辑请求单飞、物理执行排队”的组合：

1. 请求先按 `scope + normalized remote + prune mode` 查找 compatible flight；`--prune` 与非 prune 不兼容，不能 join。
2. 已有 compatible flight 时，调用者作为 follower 加入，获得同一个不可变 physical outcome envelope；每个 follower 仍各自产生 logical lifecycle 和 terminal。
3. 没有 flight 时，第一个调用者成为 leader，建立 flight，并把唯一一次物理 fetch 放入该 scope 的 mutation FIFO。
4. leader 取得临界区后执行 fetch。fetch 完成全部结算前不允许同 scope push 越过；push 执行时也不允许新 fetch leader 越过。
5. physical outcome 只有在“命令结算 → repo 级失效广播 → 本地 refs 重读”后发布。命令成功但重读失败仍为 `unknown`。

因此三个同时到达的 compatible fetch 交错为：

```text
F1: declare -> create flight X -> enqueue X -> acquire scope -> fetch
F2: declare -> join X ------------------------------------------┐
F3: declare -> join X ------------------------------------------┤
P1: declare -> enqueue push Y ------------------------ waits ---┤
F1: fetch settled -> invalidate repo snapshot -> reread refs -> publish X
F2/F3: shared physical envelope + separate logical terminal <---┘
P1: acquire scope -> validate -> ... -> publish Y
```

`forceRefresh` 只跳过 TTL，不绕过 compatible in-flight：已经有同类 fetch 时仍 join。freshness 调用最多等待 2 秒；到时返回现有 `stale/refreshing` 语义，flight 继续运行。这个 2 秒是调用者等待上限，不是为了凑单而主动 sleep。显式 fetch 不受 TTL 命中短路，但可 join 已有 compatible flight。

fetch 的物理超时为 60 秒，mutation FIFO 排队等待最多 120 秒。排队超时返回 `unknown` 并持久记录原始诊断；没有执行就必须标记 `dispatched: false`。

### 3. `ls-remote` 有两条用途，不混用旧结果

普通只读 `ls-remote` 按 `scope + normalized query` 单飞，超时 30 秒；它不进入 mutation FIFO，也不在 flight 完成后建立额外结果缓存。

push 的权威回读是写确认事务内部的 dedicated `ls-remote`，必须在同一 scope 临界区内、push 和失效之后发起。它不能 join push 之前或临界区之外创建的普通 flight，否则可能拿到旧 ref 结果。回读目标 SHA 与冻结的 expected SHA 严格相等才 confirmed；删除操作只有回读明确证明 ref 不存在才 confirmed。

### 4. push 是一次可恢复的确认事务

push 不 singleflight、不自动重试。一次写在 workflow/action lock 与 Remote Git scope 临界区都持有后，按固定顺序执行：

```text
校验 caller credential
  -> 冻结精确 source OID、destination ref 和可选 lease OID
  -> 持久化 caller-owned attempt marker
  -> 恰好一次 push dispatch
  -> repo 级 Local Git Snapshot 失效
  -> dedicated ls-remote 权威回读
  -> 严格比较预期事实
  -> confirmed | failed | unknown
```

物理 push 必须发布冻结的精确 OID，而不是在命令运行时重新解析可能移动的本地分支名。force-with-lease 的预期远端 OID 也在 marker 前冻结；删除使用明确的预期 OID，不退化为无条件删除。

attempt marker 属于发起写的现有 workflow/action 状态，不属于 Coordinator 队列。所有调用者采用同一语义形状：

```text
RemoteGitWriteAttempt
  attemptId
  scope { repoKey, repositoryId?, remote }
  operationKind
  destinationRef
  expectedOid        # 删除时为 null
  expectedRemoteOid  # 无 lease 时为 null
  status             # prepared | confirmed | failed | unknown
  preparedAt
  diagnosticRef?
```

这不是新的全局 journal、scheduler 或状态事实源。各 action 只保存自己的 attempt；Coordinator 只消费 marker 来决定“首次派发”还是“恢复回读”。写 marker 失败时禁止 dispatch。

进程中断后的规则如下：

| 中断点 | 重启可见事实 | 恢复动作 |
|---|---|---|
| marker 前 | 无 prepared attempt，且按构造尚未 dispatch | 调用方可重新申请并重新校验 |
| marker 已持久化、dispatch 前 | prepared，但远端可能未变 | 只做权威回读，不自动 push；不匹配为 unknown |
| dispatch 后、响应前后 | prepared，写结果不确定 | 只做权威回读；严格相等才 confirmed，否则 unknown |
| readback 后、terminal 持久化前 | prepared，远端事实可观察 | 重做 readback 并结算，不重放 push |

marker 先于 dispatch 会保守地产生“实际未写但恢复为 unknown”的窗口。这是刻意选择：宁可要求重新授权，也不通过自动重放制造第二次远端写。force-with-lease 在恢复时只用于解释原 attempt，不重新获取 lease 后补推。

push 返回 timeout、远端拒绝、非零退出或传输中断时，只要命令可能已到达远端，就仍执行失效和回读；readback 严格匹配可以 confirmed，否则 unknown。只有 marker/dispatch 前的本地准入或凭证拒绝可以结算为 failed/rejected，并明确记录远端零副作用。

### 5. 每类写的凭证在临界区内重新校验

锁顺序固定为“一个或多个 workflow/action lock → 一个 Remote Git scope 临界区”，禁止反向取得，以免死锁。调用者在临界区外准备候选 credential，但决定能否写的检查必须在两层锁都持有后重读当前状态并完成。

| 写入 | caller-owned credential | 临界区内必须验证 | 冻结的 push 计划与 marker owner |
|---|---|---|---|
| `syncWorktree` | workflow key、revision、worktree、branch、候选 HEAD | revision 仍当前；任务非 running/unknown；worktree/branch/HEAD 未变且工作区干净 | 精确 HEAD OID → workflow branch；sync action 保存 attempt |
| PR 创建前 push | workflow key、revision、issue、worktree、branch、候选 HEAD | revision 仍当前；issue 仍 open；尚无 PR；任务非 running/unknown；branch/HEAD/clean 未变 | 精确 HEAD OID → PR branch；PR-create action 的独立 push phase 保存 attempt，不能借用后续 GitHub PR POST marker |
| baseline restore | 已授权 target、preview fingerprint、相关 workflow revisions、候选 lease OID | 按稳定顺序持有全部相关 workflow locks；重新 preview；target/fingerprint/revisions 未变；远端 pre-read 等于授权 lease OID | 精确 target OID + exact force-with-lease；发起 restore action 保存 attempt |
| merge cleanup delete（Slice C） | merge generation/step、branch、候选远端 OID | merge 仍 confirmed；cleanup generation/step 当前；branch 仍为待清理目标；远端 pre-read 等于候选 OID | `expectedOid=null` + exact lease OID；cleanup action 保存 attempt |

PR push confirmed 后设置本地 upstream tracking 属于 Local Git 写，不塞入 Remote Git push 事务；它沿用本地写站点的失效规则。若该本地步骤失败，不能倒推已确认的远端 push 失败，workflow 需分别记录错误。

### 6. 失效边界是 repo 级，顺序不可交换

Remote Git 操作可能改变同一仓库所有 worktree 看到的 remote-tracking refs，因此 Coordinator 对已 dispatch 的 fetch/push 统一调用 `notifyLocalGitMutation({ repoKey })`，不只失效某个 worktree。现有 #122 总线会使该 repo 的仓库枚举与所有相关 worktree snapshot 失效；Coordinator 不另建第二条 invalidation bus。

顺序固定为“命令结算 → repo 级失效快照 → 重读 refs → 发布确认”。timeout、非零退出和部分输出也必须先失效再回读，因为它们不能证明远端或本地 refs 没变。尚未 dispatch 的排队超时或凭证拒绝不广播失效。

Slice B 删除远端操作调用点的散落 notify，并兑现 `check-local-git-writes` 中 `remote-git.ts` 的临时豁免说明；所有纯本地写站点的 notify 保留。Slice C 的 compound 路径在迁移前仍是具名遗留，不能被误报为已收口。

### 7. freshness 门成为同一个 owner 的入口

原 `RepositoryFreshnessGate` 的对外行为由 `RemoteGitOwner.ensureFresh` 吸收，独立 gate 类删除。下列行为必须逐项保持：

- 默认 fetch TTL 45 秒且可配置；
- `forceRefresh` 跳 TTL，但不重复启动已有 compatible flight；
- 2 秒内未完成时返回现有 stale/refreshing 响应，后台 flight 继续；
- 失败也保留既有 attempt 节流语义和原始错误，不形成热循环；
- `/state` 与 `/repo/issues` 的现有 routes TTL 测试零修改通过。

TTL observation 只影响是否需要申请 fetch，不把 remote-tracking ref 变成远端权威事实。

### 8. lifecycle event 是 Remote Git 计量的唯一来源

Coordinator 不维护一组 counters 再另写一组 evidence。每个 logical request 只产生一条可关联的 `RemoteGitLifecycleEvent` 流，阶段限定为：`declared`、`ttl-hit | joined | queued`、`dispatched`、`subprocess-settled`、`invalidated`、`readback-settled`、`terminal`。

事件至少携带 logical `requestId`、物理 `flightId`、写入时的 `attemptId`、scope、operation kind、单调时间戳、terminal outcome 和脱敏 `diagnosticRef`。token、credential、含密钥的 remote URL 和任意写入正文不得进入 evidence。

#133 的 `logical / upstream execution / join / queue waitMs / service waitMs / failures / invalidations / writeReadbacks` 全部从该事件流派生：physical outcome envelope 保存该次真实命令的 queue/service 边界，logical lifecycle 保存 follower 从 join 到 terminal 的等待；两者不可相加伪装成执行时间。生产中的 diagnostics/evidence writer 消费事件用于故障展示，CI 常驻场景测试消费它计算冻结阈值。#122 Local Git Snapshot 计数器继续只回答本地 snapshot 平面，#131 Gateway lifecycle 继续只回答 GitHub REST 平面；三者不共享可变 counter，也不建立第四份平行计量记录。

### 9. 关闭、迟到结果与恢复

`close()` 原子停止新准入。尚未 dispatch 的排队请求以 interrupted/unknown 结算并记录 `dispatched: false`；已经 dispatch 的 push 由 caller-owned marker 保留恢复依据。owner generation 对 terminal、freshness publish 和 flight removal 做 fencing，迟到结果只能追加 diagnostic，不能二次 terminal 或污染新 owner。

关闭过程在有界时间内 flush evidence，但 diagnostics 是否落盘不决定 workflow 能否推进。业务推进只看远端/本地 Git 权威回读与正式 workflow/action 状态。本文不引入 Runtime Observer、持久化 Coordinator daemon 或后台重放器。

### 10. 迁移、回滚与分片边界

Slice B 在同一实现变更中把清单内普通 fetch/push 路由到 Coordinator，并删除独立 freshness gate 和远端调用点失效；不得保留新旧两条可执行路径做长期双写。Slice C 才迁移 merge cleanup 的 `ls-remote && push --delete` 与 merge-gates 内嵌 fetch 的 compound 形态，并回填冻结场景实测证据。

本文不引入全局持久化 schema、迁移 job 或代次切换。现有 action 状态各自增加可选 attempt 子记录：旧记录无需批量转换；因为 dispatch 前强制先写 marker，旧记录中缺少 marker 只能表示没有按新协议派发。不得用“双读后猜测”兼容绕过该不变量。

回滚必须先停止新准入并确认没有 unresolved prepared attempt。仍有 marker 时先按本 ADR 回读结算为 confirmed/unknown；禁止通过回退代码丢掉恢复依据。回滚不执行 reset、stash、worktree/ref 删除，也不修改 #133 冻结脚本、阈值或 evidence 文件。

## Algorithm ↔ Data Structure Cross-check

### 算法对状态的要求

| 算法步骤 | 读取 | 写入 | owner | 无法完成时 |
|---|---|---|---|---|
| fetch join | compatible flight key | follower membership/lifecycle | RemoteGitOwner | 建 leader 或明确拒绝 |
| mutation admission | scope FIFO、deadline | queue lifecycle | RemoteGitOwner | queue timeout → unknown |
| write validation | workflow/action current state、Git refs | frozen plan | caller + owner 临界区 | rejected、零 dispatch |
| write preparation | frozen plan | durable attempt marker | caller action | marker failure、零 dispatch |
| dispatch/失效 | marker、exact refspec | lifecycle + #122 invalidation | RemoteGitOwner | 继续 readback、否则 unknown |
| authoritative readback | remote refs | attempt terminal + lifecycle terminal | caller action / owner evidence | unknown、禁止重放 |
| restart recovery | prepared attempt | readback terminal | caller action | unknown、等待新授权 |

### 结构的真实消费者

| 结构 | producer | consumer | 消费它作出的决定 | 生命周期 |
|---|---|---|---|---|
| mutation FIFO | RemoteGitOwner | scope dispatcher | 哪个 fetch/push 获得临界区 | 仅进程内，close 丢弃 |
| compatible fetch flight | leader | followers / freshness waiter | join 还是新建物理 fetch | terminal 后删除 |
| physical outcome envelope | scope dispatcher | leader / followers / #133 派生器 | 共享结果及一次物理 queue/service 边界 | flight terminal 后仅随 evidence 留存 |
| frozen push plan | credential validator | marker writer / git adapter / readback predicate | 精确写什么、如何确认 | 单次 attempt |
| caller-owned attempt | workflow/action | restart recovery / workflow settlement | 首次 dispatch 还是只回读 | 随 action 留存 |
| lifecycle event | RemoteGitOwner | diagnostics writer / #133 CI scenario | 阈值、故障证据、等待拆分 | 按 evidence 保留策略 |
| #122 invalidation | RemoteGitOwner | LocalGitSnapshotRegistry | 哪些本地 snapshot 不再可复用 | registry generation |

任何新增字段或容器若不能落入上表并指出生产消费者，必须删除，不得只为了存在性测试保留。

## Required Verification

实现必须 TDD，先用失败的真实 Git 测试固定交错，再实现；禁止 mock Git 行为。测试使用临时真实仓库和本地 bare remote，并用可控 barrier/hook 构造窗口，不以 `sleep` 猜时序。至少证明：

- 三个 compatible fetch 只有一次物理执行和两次 join；
- 同 scope fetch leader 与 push 严格串行，followers 得到共享物理信封但各有 logical terminal；
- A 仓库慢 push 不拖住 B 仓库 fetch；
- prune 不兼容不 join，force 跳 TTL 但 join 既有 flight，2 秒等待语义不变；
- 真实 push 已到 bare remote 但响应丢失，重启后只回读；remote hook 计数证明没有第二次 push；
- marker 后、dispatch 前退出产生保守 unknown，不会自动写；
- 外部竞争改变 force-with-lease 预期 SHA 时写被拒绝或 readback mismatch 为 unknown；
- timeout/nonzero 的失效发生在 readback 和 terminal 之前；未 dispatch 的拒绝不失效；
- PR push、sync、restore、cleanup 的凭证在临界区内过期时均零 dispatch；
- `/state` 与 `/repo/issues` 既有 TTL 测试零修改通过；
- #133 CI 场景从 lifecycle event 计算 logical/join/queue/service/failure/invalidation/readback，没有旁路 counter。

Key Remote Git write 使用本地 bare remote，必须满足冻结协议：恰好一次 write、恰好一次 authoritative readback、SHA 10/10 严格相等、失效先于结果消费、P95 ≤93ms。冻结的 `scripts/measure-access-baseline.mjs`、阈值与 evidence 文件不得修改。Review-dense 的最终实测证据仍由 Slice C 回填，不由 Slice B 宣称完成。

## Consequences

### Positive

- fetch 的“可合并”和“会改本地 refs、须与 push 互斥”不再互相矛盾。
- push 响应丢失或进程退出后有可审计的 readback-only 恢复路径，不依赖自动重放。
- 每类写权限都落到现有 workflow/action 所有权，并在真正串行化点重新校验。
- 远端操作只复用 #122 的失效总线，指标只来自一条 Remote Git lifecycle，概念数量受控。
- 每个 scope 独立，慢 remote 的影响不会扩散成全局停顿。

### Negative

- workflow/action lock 会覆盖最多 120 秒的同 scope 排队等待；同 workflow 的其他动作会保守等待。
- marker-before-dispatch 会制造可解释的 false unknown，需要用户重新授权，而不是后台自愈。
- exact-OID refspec、逐类 credential 和 dedicated readback 增加了适配层分支，必须由交错集成测试守住。
- 单进程 owner 不协调两个 Controller 进程；v0.2 仍依赖调用方租约和 Git 的 lease/ref 事实阻止冲突。

### Neutral

- 本 ADR 借用 ADR-0010 的 caller-owned marker、readback-only recovery 和 lifecycle-as-metrics 模式，但不复用其 Gateway runtime、credential scope、队列、缓存或事件对象；Remote Git 与 GitHub REST 仍是两个访问平面。
- 数值使用 #135 Q8 与 #133 冻结值，不在实现中另设“更合理”的默认值。

## Failure Modes

- **flight key 过宽**：prune 与非 prune 错误 join 会丢语义；必须由 normalized mode 区分。
- **push readback join 旧 flight**：可能把写前事实当写后事实；dedicated readback 必须在临界区内新发起。
- **临界区前校验**：状态可在排队时过期；临界区内重读失败即零 dispatch。
- **移动 source ref**：用 branch name 推送可能偏离 marker；必须推 exact OID。
- **lost response**：不得按退出码猜成功；失效、回读、严格谓词后才结算。
- **marker 丢失**：无 marker 不能证明旧进程未写；新协议从构造上禁止 marker 前 dispatch，违反者是阻断性缺陷。
- **锁顺序反转**：可能在 workflow lock 与 remote lock 间死锁；所有调用方只允许既定顺序。
- **repoKey 轮换**：v0.2 不自动把旧 owner 状态迁入新 key；旧 owner close，新 owner 冷启动，unresolved marker 仍由 caller action 恢复。
- **evidence writer 失败**：原始错误必须进入本地可展示诊断；业务结果仍由 refs 和 action 状态回答，不因计量缺失伪造 confirmed。

## Alternatives Considered

- **只有 per-scope FIFO，不做 fetch singleflight**：拒绝；直接违反 Review-dense 的“一次 fetch、两次 join”。
- **fetch 在队列外执行，只有 push 入队**：拒绝；fetch 会修改 remote-tracking refs，与 push/回读交错后无法给出稳定失效顺序。
- **持久化 Coordinator 队列或 daemon**：拒绝；会成为第三个写所有者，并把 crash recovery 扩成分布式租约/去重协议。
- **进程重启后重放 prepared push**：拒绝；响应丢失时可能产生第二次远端写，force-with-lease 也不能证明业务仍授权重放。
- **所有写统一成一种抽象 lease**：拒绝；四类写的权威状态和成功条件不同，抽象会掩盖实际校验。
- **共享 #122 counters 或 #131 Gateway events**：拒绝；三个访问平面回答的问题不同，共享可变计数会混淆归属；本 ADR 只共享 #122 invalidation bus。
- **worktree 级失效**：拒绝；fetch 更新 repo 共享的 remote-tracking refs，只失效一个 worktree 会留下可复用旧快照。

## Acceptance and Effective Baseline

维护者已于 2026-09-02 明确接受本文中的 fetch 组合算法、caller-owned marker、四类 credential、repo 级失效和 lifecycle 唯一来源。本文与索引现标记为 Accepted 候选，但在合入 `main` 前仍不是生效的 Coding baseline，也不表示 Slice B READY。只有以合入 `main` 的 exact SHA 重跑 impl-gate 得到 READY，且用户另行授权编码后，Slice B 才能开始实现。

若维护者要求改变 marker owner、锁顺序、恢复重放规则或任一写凭证，这不是实现细节，必须修改本文后重新接受和重跑闸门，禁止 Coding Agent 在实现中自行决定。

## References

- [ADR-0001：架构事实源](0001-architecture-source-of-truth.md)
- [ADR-0002：权威事实与缓存](0002-authoritative-facts-and-cache.md)
- [ADR-0003：Issue 架构闸门](0003-issue-architecture-gate.md)
- [ADR-0004：策略控制的自动交付](0004-policy-controlled-autonomous-delivery.md)
- [ADR-0005：已废弃的 Runtime Observer 模型](0005-deterministic-loop-guard-and-runtime-observer.md)
- [ADR-0006：Canonical Domain Model 与契约](0006-canonical-domain-model-and-contracts.md)
- [ADR-0007：Git 与 GitHub 三访问平面](0007-three-git-github-access-planes.md)
- [ADR-0008：确定性停机与可选 Observer](0008-deterministic-loop-guard-and-optional-runtime-observer.md)
- [ADR-0009：v0.2 clean break](0009-v02-clean-break-local-state-and-config.md)
- [ADR-0010：GitHub REST Gateway 生命周期](0010-github-rest-gateway-admission-and-lifecycle.md)
- [Remote Git access baseline](../../baselines/v0.2-access-baseline.md)
- [权威事实与所有权模型](../authority-model.md)
- [核心数据流](../core-data-flow.md)
- [Issue #135](https://github.com/ai-daming/clickvibe/issues/135)
