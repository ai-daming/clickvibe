# ADR-0013：v0.2 退出验收——单一写入守卫、终局汇总与 clean-break 执行

> Status: Accepted | Date: 2026-09-03 | Issue: #137（依赖 #122/#131/#133/#134/#135/#136） | Extends: [ADR-0009](0009-v02-clean-break-local-state-and-config.md)、[v0.2 升级协议](../v02-upgrade-protocol.md) | Related: [ADR-0007](0007-three-git-github-access-planes.md)、[ADR-0010](0010-github-rest-gateway-admission-and-lifecycle.md)、[ADR-0011](0011-remote-git-coordinator-admission-and-recovery.md)、[ADR-0012](0012-work-item-contract-canonicalization-and-evidence.md)

## Context

#137 是 v0.2 收官 issue。impl-gate（2026-09-03，baseline `73aaf2370121b7c1bb263a9cc01090187a38b832`）判定：升级机器、三平面计量、写后回读与冻结阈值均已落地并被测试锁定，但四类「验收方法」没有任何成文工件：

1. 每类已切换状态的「单一写入模型 + 当前状态应答源」如何枚举、如何被机器守住（现有 `check:state-writes` 只守 workflow 持久化一类）；
2. 三平面终局负载汇总的 harness 形态与失败证据落盘方式；
3. provider-neutral 架构审计的方法与通过判据（canonical-domain-model.md 只有义务陈述）；
4. v0.1 资产处置表的落点与生成方法。

另有两个执行侧缺口：真实切换没有操作者入口（`applyV02Upgrade` 仅被测试消费），以及「active legacy reader」缺精确判据（`src/infra/runtime.ts` 的 v0.1 config 分支、`src/infra/state.ts` 的 legacy 迁移族仍在）。

这些属于 L3 验收机制，不得在验收实现里即兴。本 ADR 补齐这六项方法；实现授权仍需在合入后的 exact SHA 上重跑 impl-gate 并由用户单独给出。

## Decision

### 1. 状态类单一写入枚举与机器守卫（AC5）

已切换状态的**状态类清单是封闭枚举**，以本 ADR 为唯一登记处；新增状态类必须先修订本表再落代码。基线 SHA 上的完整清单：

| 状态类 | 物理位置（root = `~/.clickvibe/state`） | 唯一写入模型 | 当前状态应答源 | fail-closed 判据 | 守卫 |
|---|---|---|---|---|---|
| workflow 持久化 | `<owner>/<repo>/issue-N/workflow.json` 与同目录 task JSONL | `src/infra/workflow-persistence.ts` 的语义命令（revision/CAS） | `workflow.json` 经持久层读函数进入 derive | revision 冲突即 `WorkflowConflictError`；路径只允许持久层引用 | `check:state-writes`（已有） |
| WorkItemContract capture | `work-items/<key>/contract/captures/*` 与 `current.json` | `src/infra/work-item-contract-store.ts` 的 `publishWorkItemContractCapture`（immutable bundle + 原子 current 指针，ADR-0012） | `readCurrentWorkItemContract`（`current.json` 单指针） | bundle `schemaVersion≠1`、损坏、部分发布 → `unknown`，不得冒充成功 | 本 ADR 新增 tripwire |
| diagnostics JSONL | `work-items/<key>/diagnostics.jsonl`（含轮转段） | `src/infra/diagnostic-log-store.ts` 的 `appendDiagnosticLine`（per-path 串行队列 + 单段轮转） | JSONL 本身（append-only 证据流，无「当前值」语义） | 无 schema 门是**声明的 N/A**：append-only 日志不产生需要判别的当前状态；行级损坏由读取方按行保留原始字节并跳过，不得改写文件 | 本 ADR 新增 tripwire |
| active config | `~/.clickvibe/config.yaml` | 升级机器 cutover 的原子 replace；运行时只读 | `loadConfigFromHome`（schema-1 + verified journal + state marker + config digest 配对校验） | 配对任一失败即抛错（已有 `loadV02Config`） | 本 ADR 新增 tripwire |
| state 根 marker | `<state>/.clickvibe-state.json` | 升级机器（staging 内创建，rename 激活） | `loadV02Config` 配对读取 | marker 与 journal fingerprint 不一致即抛错 | 同 config 守卫 |

**守卫扩展方法**：把 `scripts/check-state-writes.mjs` 从单文件 tripwire 推广为按类的「写入面 → 允许模块」静态枚举，规则与现有实现同构（AST 检测目标路径构造标识符与导入边界，allowlist 显式列出每个类的 owner 模块与允许符号）：

- contract 类：`workItemContractPaths`、`current.json` 的构造与任何 fs 写原语调用只允许出现在 `src/infra/work-item-contract-store.ts`；
- diagnostics 类：`diagnosticLogPath` 的结果只允许 `src/infra/diagnostic-log-store.ts` 写入；`appendDiagnosticLine` 是唯一写入口；
- config/marker 类：`config.yaml`、`.clickvibe-state.json` 的写入只允许 `src/infra/v02-upgrade-*.ts`（运行时文件出现写原语即红）。

allowlist 条目必须带理由注释，与 `check:github-access` 的符号级边界实践一致。枚举表的文本形态只存在于本 ADR；机器可执行形态存在于脚本 allowlist，两者由 Review 对应，不引入第三份 JSON 配置（概念预算：表的消费者是本 ADR 的读者与门禁脚本，无第四个消费方）。

### 2. 三平面终局汇总 harness（AC6/AC7/AC8）

**计数权威 = CI 常驻聚合测试**：新增 `tests/v02-final-acceptance.test.ts`（可按场景拆分为多个文件，命名前缀 `v02-final-*`），复用 `tests/local-git-snapshot-scenario.test.ts` 的 #122 范本——真实 git 仓库 + 真实 shell，`gh` 以可编程 fake 拦截（离线确定性）。测试执行 #133 冻结的多 Work Item 场景，断言**只**消费三套既有派生：

- Local Git：`LocalGitSnapshotRegistry` counters（含恒等式 `logical = hits + joins + executions + failures`）；
- GitHub REST：`deriveGatewayMetrics(lifecycle events)`；
- Remote Git：`deriveRemoteGitMetrics(lifecycle events)`。

**禁止第四套计数**是结构性约束：该测试文件不得自建任何计数器或对 shell 调用另行计数；shell 拦截层仅用于离线化 `gh` 与记录命令清单作失败证据，不产生指标。

**阈值对照**：冻结表（`docs/baselines/v0.2-access-baseline.md`）逐行映射——panel/multi/review 三场景的计数断言进 CI 测试；isolated-write 对照既有 `scenarios/remote-git-key-write.test.ts` 与 Gateway 写确认测试（写→失效→权威回读事件齐全）；rate 行断言「每个 GitHub 响应记录 bucket/used/remaining/reset 或显式 unknown」。延迟值不进断言（实测机噪声），由实测汇总承担。

**失败证据落盘**：任一断言失败时，测试在失败信息中完整输出三平面原始记录（lifecycle 事件数组、counters 快照、逐条 shell 命令与退出码）；原始数据进 CI 日志即落盘，不得截断、不得为转绿改阈值。**未达阈值 = 测试红 = AC 不通过**，不存在「主要能力已实现」的软关闭。

**实测汇总文档**：`docs/baselines/v0.2-final-acceptance-<shortsha>.md` + 原始 JSONL，绑定最终 head exact SHA；由冻结脚本 `scripts/measure-access-baseline.mjs` **原样**重跑产生（哈希守卫证明脚本一个字不可动，且其在当前 HEAD 仍调用生产路径——`enrichWorkflowStates` 缺省走全局 registry）。P50/P95 仅描述性对照。

**Controller/Agent 分离**：汇总文档固定两节。Controller 节引用三套派生的实测输出；Agent 节只引用任务日志样本标识与允许能力清单，明确盲区（复合 shell、子进程、丢失输出不可见）。任何位置不得把 Controller 指标写成 Agent 全量。

### 3. provider-neutral 审计（AC9）

**core 模块集（封闭清单）**：`src/infra/contracts.ts`、`src/infra/work-item-identity.ts`、`src/infra/project-binding.ts`、`src/infra/repository-identity.ts`、`src/workflow/work-item-contract.ts`、`src/infra/state-view.ts` 及 `src/workflow/` 内不 import `src/github/**` 的纯逻辑文件。provider 专属组装（如 `work-item-contract-repository.ts`、`src/github/**`）按定义排除在 core 之外——GitHub 字段只在 Adapter 边界校验和转换（ADR-0006/0007 既有决策）。

**方法**：新增 `scripts/check-provider-neutral.mjs`，AST 扫描 core 集合，违规判据（全部机械可判、未知即红）：

1. import 任何 `src/github/**` 模块（与层规则互补：层规则已禁 infra→github，本规则把 workflow 纯逻辑同样纳入）；
2. 含 `gh api|pr|issue` 命令构造字面量（与 `check:github-access` 的边界互补）；
3. 含 `'github'` / `'github.com'` 字面量或 GitHub 响应形状的类型引用（封闭名单：`html_url`、`node_id`、`updated_at`、`GithubRest*`、`GithubPr*` 等前缀匹配），出现在类型声明或非参数位置。

**通过标准**：零未登记命中；命中必须以带理由的 allowlist 条目登记（预期初始为空）。**证据形态**：CI 门禁输出 + 终局汇总文档附「core 清单与结果」一节。**残余盲区（声明）**：新增于清单外目录的 core 类型文件不被自动发现，由层规则与 `check:github-access` 兜底，Review 时对照本节清单。

### 4. v0.1 资产处置表（AC1）

**落点**：`docs/architecture/v01-asset-disposition.md`（与 v0.2 退出工件同域，进 git 版本化；issue 评论只留引用链接，因为评论是历史证据层，不承载长期契约工件）。

**表结构**（每行必填）：资产类 / 具体资产（文件、路径或符号，绑定 baseline SHA） / 处置（保留 | 重构 | 归档 | 废弃） / owner 模块 / 生产消费者 / 处置理由（绑定 ADR 条款） / 回滚边界（冷备份路径与恢复动作）。

**生成方法**：以 baseline SHA 的全量静态枚举为底稿——`rg -n 'legacy|Legacy' src`、v0.1 config 分支、`migrateLegacy*` 函数族、`docs/plans/` 旧实施记录——逐条人工标注。移除实现 PR 必须逐行对应表项并附枚举命令输出，存在性缺口一次找全。

**与 AGENTS.md 的对齐**：处置 ≠ 大扫除。「废弃」的唯一授权来源是 ADR-0009 Decision 1 与本 ADR §6 的判据，仅覆盖 v0.1 兼容分支；既有业务逻辑仍只搬移与分层；Git worktree/branch/commit 与 Provider 事实不属于本地资产、不进表；冷备份与旧现场不自动删除，删除须另行走显式预览与授权。

### 5. 操作者入口与授权确认记录（AC2/AC3 执行侧）

**形态**：新增 `scripts/upgrade-v0.2.mjs` 离线 runner（薄组装层，不得复制或绕过 library 内的 fence/lock/fingerprint 校验）：

- `node scripts/upgrade-v0.2.mjs preview`：调用 `previewV02Upgrade`（`home = os.homedir()`，`baselineSha` 取仓库当前 `git rev-parse HEAD`），打印完整 plan 摘要、fingerprint 与全部将写入路径。零写入。
- `node scripts/upgrade-v0.2.mjs apply --fingerprint <fingerprint>`：要求操作者以参数**回显完整 fingerprint** 作为显式授权凭证；回显值与 preview fingerprint 不一致即拒绝并零写入。随后构造离线 fence（固定声明串 `host-stopped-and-restart-disabled`）执行 `applyV02Upgrade`，打印结果与 journal 路径。
- `resume` / `rollback` 同入口，走 `previewV02UpgradeRecovery` + fingerprint 回显，语义同上。

**确认证据**：runner 在 apply/resume/rollback 获得回显确认后，向 `~/.clickvibe/upgrade-v0.2-authorization.log` 追加一行 JSON：`{ at, entry: 'offline-runner-1', command, fingerprint }`（append-only，exclusive 追加，损坏行不阻断后续审计）。该日志是 AC2「显式授权」的事后审计证据，消费者为 #137/#132 的证据回填；journal 内的 `planFingerprint` 仍是授权绑定的机器权威——两者不一致时以 journal 为准，授权日志缺失标记「存在未经 runner 的直接 apply」。不引入 TTL：授权有效期由 apply 临界区内的 fingerprint 重算回答（协议 §8 既有语义），不新增第二个时效概念。

### 6. active legacy reader 判据与移除清单（AC3）

**判据（可判定）**：

- **是 legacy reader**：运行时代码路径把 v0.1 格式解释为 active 状态——(a) 读取无 `schemaVersion` 的 config 并当作有效配置继续（`src/infra/runtime.ts` `loadConfigFromHome` 的 v0.1 分支）；(b) 读取或迁移 v0.1 state 布局（state 根 `*.json`、`archive/`、`legacyIssueKey` 别名、v0.1 扁平日志的启动迁移）；(c) 对 active 输入按 v0.1 workflow key 语法做兼容回退解析。（勘误：初稿把 `diagnosticLogPath` 的 issue-key 分支与 `appendLog`/`readLogHistory` 在**现行** workflow key 下的扁平日志通道误列为 legacy——两者服务当前 key 编码，判据不命中，随移除实现 PR 修正；v0.1 侧真正移除的是启动迁移族、`legacyIssueKey` 别名探测与 v0.1 repos 写入器。）
- **不是 legacy reader**：升级机器（`src/infra/v02-upgrade*.ts`）对 v0.1 字节的解析——那是转换输入，ADR-0009 明确授权；测试 fixture；纯文案提及。

**移除后行为**：v0.2 runtime 遇到无 `schemaVersion` 的 config → fail-closed 报错并指向升级入口；active 路径不再有 legacy key 回退分支。`owner/<repo>/issue-N` 目录布局是现行 workflow 存储布局，**不是** legacy reader，不在移除范围（工作项 key 全量迁移是另一个需求，本 ADR 不授权）。

**已知清单（baseline `73aaf23`）**：`src/infra/runtime.ts` v0.1 config 分支；`src/infra/state.ts` 的 `migrateLegacyState`/`migrateLegacyWorkflowFile`/`migrateWorkflowLogs`/legacy 存储 key 别名与 `appendLog` 的 legacy 别名探测；`src/infra/state-layout.ts` 的 `legacyIssueKey`；`src/infra/task-log-store.ts` 的 `migrateLegacyLog`；`src/infra/project-config.ts` 的 v0.1 repos 写入器及其消费方 `src/workflow/project-import.ts`。实现 PR 必须附 `rg -n 'legacy|Legacy' src` 全量输出并逐条分类（fence 守卫 / 升级机器 / 待移除 / 文案），清单以枚举输出为准，不得凭记忆裁剪。

## Algorithm ↔ Data Structure Cross-check

| 算法/迁移 | 读取状态 | 写入状态 | owner/串行点 | 失败结果 |
|---|---|---|---|---|
| runner 授权确认 | preview plan + fingerprint | `upgrade-v0.2-authorization.log` 追加一行 | 操作者回显；apply 临界区重算为最终裁决 | 回显不匹配 → 拒绝、零写入；临界区 facts 变化 → 授权失效 |
| 状态类守卫 | 源码 AST | 无（门禁结论） | `check:state-writes` 扩展，CI 串行 | 越界写入面 → CI 红 |
| 终局汇总断言 | 三套派生输出 + 冻结阈值表 | 失败时的完整原始记录（CI 日志） | CI test runner | 阈值未达 → 测试红，原始指标保留 |
| provider-neutral 扫描 | 源码 AST（core 封闭清单） | 门禁结论 | `check-provider-neutral`，CI 串行 | core 内 GitHub 标识 → CI 红 |
| legacy 移除 | grep/AST 全量枚举 | 源码删除（逐项对应处置表行） | 实现 PR + Review | 行为回归由既有测试与新增 fail-closed 测试守护 |

| 概念 | 生产者 | 生产消费者 | 行为差异 | 生命周期 |
|---|---|---|---|---|
| `upgrade-v0.2-authorization.log` 行 | offline runner | #137/#132 证据回填（审计） | 证明授权绑定到具体 fingerprint 与时刻 | append-only；随 `~/.clickvibe` 保留，不随冷备份搬迁 |
| 状态类枚举表 | 本 ADR §1 | 门禁脚本 allowlist、AC5 验收证据 | 新增状态类必须先扩表与守卫 | 随 ADR 修订演化 |
| 终局汇总证据（md + jsonl） | 冻结脚本实测 + CI 聚合测试 | AC6/7/8 勾选依据 | 阈值对照的唯一结论来源 | 绑定 exact SHA，一次性工件 |
| 处置表 | 设计/实现 PR | 移除 PR 逐行对应、Review、回滚时定位资产 | 何者可删与回滚边界 | v0.2 退出后随文档归档 |

## Required Verification

- **runner**：错误 fingerprint 回显 → 拒绝且文件系统零变化（含授权日志）；正确回显 → 授权日志行与 journal `planFingerprint` 一致；preview 零写入。
- **守卫扩展**：为每类构造一个越界写入 fixture → 门禁红；合法 owner 写入 → 绿；allowlist 无理由条目 → 红。
- **汇总 harness**：绿路径达到冻结计数阈值；注入一次失败（如热轮多跑一次本地 Git）→ 测试红且失败信息含三平面原始记录全文。
- **provider-neutral**：向 core 模块植入 `'github.com'` 字面量与 `gh api` 构造 → 红；移除 → 绿。
- **legacy 移除**：v0.1 config 出现 → fail-closed 错误并指向升级入口（新测试）；枚举输出全分类；`pnpm run typecheck && pnpm run build && pnpm test` 全绿。
- **全门禁**：`AGENTS.md` §5 交付链含新脚本（`check:state-writes` 扩展、`check:provider-neutral`）全绿。

## Consequences

### Positive

- AC5 从人肉表格变成机器守卫的封闭枚举；第四套计数与越界状态写入在 CI 即红。
- 终局验收有可重跑的权威形态（CI 计数）与绑定 SHA 的实测层，失败证据不可抹去。
- 真实切换有了显式入口与可审计的授权记录，AC2 的「显式授权」可被回填证明。

### Negative

- 两个新脚本与一个 runner 增加维护面；守卫误报需要带理由的 allowlist 维护。
- legacy 分支移除后，直接用 v0.2 runtime 打开 v0.1 现场会得到 fail-closed 错误（这是 ADR-0009 的既定取舍，本 ADR 只是把错误显式化）。

### Neutral

- 授权日志与 journal 双记录以 journal 为权威；实测延迟仍受机器噪声约束，计数优先。

## Failure Modes

- **绕过 runner 直接调 library apply**：机器校验不受影响（fingerprint/lock/fence 照常），审计层表现为授权日志缺失，标记「未经 runner 的 apply」。
- **守卫或扫描误报/漏报**：误报以带理由 allowlist 收敛；漏报面由层规则、`check:github-access` 与 Review 对照本 ADR 清单兜底。
- **汇总测试在 CI 抖动**：只可能来自非确定性计数（真实并发行为），按失败证据修复生产代码，不得改断言或阈值。
- **处置表与代码漂移**：移除 PR 逐行对应 + 枚举输出复核；后续新增资产类必须先修 ADR §1 再落码。

## Alternatives Considered

- **枚举表做成独立 JSON 配置**：拒绝——概念预算，表的消费者只有 ADR 读者与门禁脚本，脚本内 allowlist 即机器形态。
- **终局汇总用独立 mjs runner**：拒绝——CI 常驻测试才是可重跑的权威；实测层已由被哈希守卫的冻结脚本承担。
- **处置表放 issue 评论**：拒绝——评论是历史证据层；长期契约工件须进版本化 docs。
- **给授权加 TTL/时效概念**：拒绝——apply 临界区 fingerprint 重算已完整回答「预览过期」，新增时效是第二事实源。
- **顺手全量迁移工作项 key**：拒绝——超出 #137 范围（YAGNI），现行布局不是 legacy reader。

## References

- [v0.2 升级协议](../v02-upgrade-protocol.md)（§12 附节引用本 ADR）
- [ADR-0009](0009-v02-clean-break-local-state-and-config.md) · [ADR-0007](0007-three-git-github-access-planes.md) · [ADR-0010](0010-github-rest-gateway-admission-and-lifecycle.md) · [ADR-0011](0011-remote-git-coordinator-admission-and-recovery.md) · [ADR-0012](0012-work-item-contract-canonicalization-and-evidence.md)
- #133 冻结基线：`docs/baselines/v0.2-access-baseline.md`
- 既有守卫实践：`scripts/check-state-writes.mjs`、`scripts/check-github-access.mjs`、`scripts/check-import-layers.mjs`
