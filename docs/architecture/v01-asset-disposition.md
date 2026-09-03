# v0.1 资产处置表

> Status: Active（#137 AC1 交付物） | 依据: [ADR-0009](decisions/0009-v02-clean-break-local-state-and-config.md) · [ADR-0013 §4/§6](decisions/0013-v02-exit-verification-single-writer-and-cutover-execution.md) | 枚举基线: `6c35d77bed874b94afed62cc11c1ceb1fabfe0b6`

本表逐类标记 v0.1 代码与数据资产的处置（保留 / 重构 / 归档 / 废弃），记录 owner、生产消费者、处置理由与回滚边界。「废弃」的唯一授权来源是 ADR-0009 Decision 1 与 ADR-0013 §6 的判据，仅覆盖 v0.1 兼容分支；**处置 ≠ 大扫除**：既有业务逻辑仍只搬移与分层（AGENTS.md §4），冷备份与 Git/Provider 现场不自动删除。

## 生成方法

以枚举基线 SHA 执行全量静态枚举并逐条分类（存在性缺口一次找全）：

```sh
rg -n 'legacy|Legacy' src --glob '*.ts'          # 109 处（含围栏守卫与注释）
rg -n 'assertLegacy|V02GenerationViolation' src  # 围栏守卫调用（保留类）
rg -n 'repos' src/infra/runtime.ts               # v0.1 config 分支与内存映射
rg -n 'migrateLegacy' src                        # v0.1 state 迁移族
```

分类判据（ADR-0013 §6）：把 v0.1 格式解释为 active 状态的运行时路径 = 待废弃；升级机器对 v0.1 字节的解析、现行格式的内容容错、防御性 stale 判定、纯注释 = 保留；v0.1 数据 = 归档（冷备份）；Git/Provider 事实 = 外部权威，不在处置范围。

## A. v0.1 config 格式（repos map）

| 资产 | 处置 | owner | 生产消费者 | 理由（ADR 绑定） | 回滚边界 |
|---|---|---|---|---|---|
| `src/infra/runtime.ts` `loadConfigFromHome` 的无 `schemaVersion` 分支 | 废弃 | infra/runtime | 全部路由经 `loadConfig` | ADR-0009 D1；ADR-0013 §6(a)。移除后 v0.1 config → fail-closed 并指向升级入口 | `config-v0.1-backup-*.yaml` + 协议 §10 rollback；代码级 git revert 移除 PR |
| `src/infra/project-config.ts` `addProjectRepoMapping`（v0.1 repos 读改写写入器） | 废弃 | infra/project-config | `src/workflow/project-import.ts` | ADR-0013 §6(a)。向 schema-1 config 写 `repos` 会破坏 config digest 与 journal 配对（`loadV02Config` 直接 fail-closed）；cutover 后已被代次围栏阻断（`assertLegacyStateWriteAllowed` 见 v0.2 marker 即抛错），移除使错误显式化 | 同上；cutover 前的最后写入仍受围栏保护 |
| `src/workflow/project-import.ts` 面板项目导入流程（消费上述写入器） | 废弃 | workflow/project-import | 项目导入路由/命令 | 随 v0.1 写入器移除；导入入口 fail-closed 报错。**v0.2 项目新增入口（ProjectBinding 创建/验证）为显式非目标**，需另行需求与设计 | 代码级 git revert；不涉及数据 |
| `ClickVibeConfig.repos` 内存映射（`loadV02Config` 从 bindings 派生） | 保留 | infra/runtime | 全部 `config.repos` 消费者 | 内存适配层非持久格式；持久层唯一格式是 schema-1 ProjectBinding。统一到 binding 消费者属未来重构，本表不授权 | 不适用（非持久资产） |

## B. v0.1 state 布局读取与迁移

| 资产 | 处置 | owner | 生产消费者 | 理由 | 回滚边界 |
|---|---|---|---|---|---|
| `src/infra/state.ts` `migrateLegacyState`/`migrateLegacyWorkflowFile`/`migrateWorkflowLogs`（state 根 `*.json`、`archive/`、`<key>.log` 迁移族） | 废弃 | infra/state | `loadStates`/`readWorkflow` 启动路径 | ADR-0009 D1/D2：v0.2 active state 为全新目录，不存在 v0.1 布局输入；ADR-0013 §6(b) | state 冷备份 `state-v0.1-backup-<ts>-<nonce>`；代码级 git revert |
| `src/infra/state.ts:442-449` legacyAlias `<key>.log` 读取 | 废弃 | infra/state | task 日志读取 | 同上 §6(b) | 同上 |
| `src/infra/task-log-store.ts` `migrateLegacyLog` | 废弃 | infra/task-log-store | state.ts 迁移族 | 同上 §6(b) | 同上 |
| `src/infra/state-layout.ts` `legacyIssueKey` 及 state.ts 消费（含 `appendLog` 的 legacy 别名探测） | 废弃 | infra/state-layout | state.ts | §6(c)：active 路径不做 v0.1 workflow key 兼容回退 | 同上 |

## C. 保留类（判据不命中，逐条说明）

| 资产 | 处置 | 理由 |
|---|---|---|
| `sampleWorktreeFactsLegacy` + `deriveWorkflowState` 缺省路径（`src/workflow/derive.ts:40,128`） | 保留 | #122 的等价基线与无 observation 注入时的缺省路径；采样的是实时 Git 事实，非 v0.1 格式 reader（§6 判据不命中）；亦为导出面锚点（AGENTS.md §3.2） |
| `decodeLiveLogLine` 纯文本行容错（`src/infra/live-output.ts`） | 保留 | 现行 task JSONL 内未标记行的容错读取；JSONL 是现行格式 |
| `bodyHash` 解码证据（`src/infra/state.ts:138`、`derive-from-facts.ts:127`） | 保留 | 只读历史证据，已显式「永不授权 v0.2 verdict」 |
| workflow-session legacy/unknown owner stale 判定（`src/infra/workflow-session.ts:48`） | 保留 | 防御性 fail-closed（缺失≠死亡原则），非格式 reader |
| `diagnosticLogPath` 的 issue-key 分支与 `appendLog`/`readLogHistory` 现行 key 扁平日志通道 | 保留 | 服务**现行** workflow key 编码与 taskless 动作日志（worktree 恢复路径在用），非 v0.1 格式 reader（ADR-0013 §6 勘误）；taskless 日志的 v0.2 终态属未来需求 |
| `LegacyV02UpgradeLockOwner`（`src/infra/v02-upgrade-lock.ts`） | 保留 | 协议 §3.1 要求识别 schema 1 旧锁 owner，PID 存活不抢锁 |
| derive/local-git-sampler/repository-state 等处 "legacy parity" 注释族 | 保留 | 行为对齐说明，无代码分支 |
| `src/infra/v02-upgrade*.ts` 的 v0.1 解析（`parseLegacyConfig`、state inventory、恢复 inventory） | 保留 | 升级机器的转换输入，ADR-0009 明确授权；ADR-0013 §6 明确非 active reader |

## D. v0.1 数据资产（非代码）

| 资产 | 处置 | 位置 | 回滚边界 |
|---|---|---|---|
| 旧 `~/.clickvibe/state` 全目录 | 归档 | 冷备份 `~/.clickvibe/state-v0.1-backup-<ts>-<nonce>` | 人工恢复/审计材料；不授权 v0.2 动作、不自动删除；恢复 v0.1 运行须走协议 §10 rollback 配对恢复 |
| 旧 `config.yaml` 原始字节 | 归档 | `~/.clickvibe/config-v0.1-backup-<ts>-<nonce>.yaml` | 同上 |
| Git worktree / branch / commit / dirty / ahead 现场与 Provider 事实 | 保留（不处置） | Git 仓库与 GitHub | 外部权威事实（ADR-0009 D4/D5）；继续旧现场须显式采用 + 重新观察 + 重新授权 + 重新 Review |

## 非目标

- v0.2 运行期的项目新增入口（ProjectBinding 创建/验证流程）——真实需求出现时另行设计。
- 工作项存储 key 从 `owner/repo#issue` 到 WorkItemIdentity 的全量迁移——现行布局非 legacy reader（ADR-0013 §6）。
- 冷备份与旧 worktree 的清理/删除——永久排除自动删除，删除须独立预览与授权。
