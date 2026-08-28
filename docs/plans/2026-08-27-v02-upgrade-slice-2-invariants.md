# #134 Slice 2 升级不变量与写入路径枚举

> Implementation baseline: `553a926405919bd3efc677fbd9bf0388f7c6a26d` | Architecture baseline: `c866399f360fd3505be9b16980e56cc931308d9a` | Protocol: `docs/architecture/v02-upgrade-protocol.md`

本文不是新的架构决策。它把 Accepted 升级协议翻译成 Slice 2 的施工检查表，供 Coding 和 exact-SHA Review 对照。

## 不变量

1. **代次配对只有两种合法答案**：legacy config + legacy state，或 schema-1 config + v0.2 state marker；混合代次、unknown schema 和损坏 journal 都不可写。
2. **升级阶段只有 journal 回答**：文件存在或缺失只能用于验证 journal，不能自行推导 `prepared`、`verified` 或 `rolled_back`。
3. **preview 零磁盘写入**：repositoryId 候选、备份名、staging 名和目标 config 都先进入 plan；授权只绑定这一份 plan fingerprint。
4. **写权限由双凭证构造**：apply/resume/rollback 必须同时持有跨进程 upgrade lock 和当前宿主 generation fence；校验在两者内部完成。
5. **prepare 不破坏 legacy 配对**：journal、config backup、repositoryId、staged config/state 全部回读成功后才允许 cutover。
6. **cutover 只执行已记录的本地 rename/replace**：每个破坏性动作先 durable 写 intent，动作后回读，再 durable 写 done。
7. **事实变化使授权失效**：锁和 fence 内重做完整观察；fingerprint 不一致时零 sidecar、零 backup、零 staging 写入。
8. **Git 现场只观察**：worktree、branch、HEAD、dirty、conflict、ahead 不自动导入、reset、stash、删除或 push。
9. **cold backup 永不自动删除**：rollback 只移动 journal 精确证明属于本次升级的路径，不递归清理不明资产。
10. **v0.2 marker 是 legacy 写入禁令**：一旦 active state 是 v0.2，legacy workflow、task log、diagnostic 和 config `repos` 写入口全部 fail closed。

## 原子提交单元

- plan authorization：完整 `UpgradePlan` + fingerprint，一次性消费。
- prepare：journal 每个 phase 是独立 durable 原子记录；legacy config/state 仍保持原配对。
- state cutover：`state-backup-intent/done` 与 `state-activate-intent/done` 分段记录并回读。
- config cutover：`config-activate-intent/done` 分段记录并完整 parse/read-back。
- terminal：只有 read-back 全通过才能写 `verified`；只有 legacy 配对恢复并回读才能写 `rolled_back`。

## 写入路径静态枚举

| 路径 | 当前写入口 | Slice 2 保护方式 |
|---|---|---|
| `~/.clickvibe/config.yaml` legacy `repos` | `src/infra/project-config.ts` | schema/journal generation gate；schema 1 拒绝 legacy mutation |
| workflow JSON | `src/infra/workflow-persistence.ts` | cross-process workflow lock 内检查 active state generation |
| legacy workflow 搬移 | `src/infra/state.ts::migrateLegacyState` | 扫描前和每个 mkdir/link/rm 前检查 generation；generation violation 不得被 best-effort catch 吞掉 |
| task JSONL | `src/infra/task-log-store.ts` 经 `state.ts` | state generation gate；不得吞掉 generation violation |
| diagnostic JSONL | `src/infra/diagnostic-log-store.ts` 经 `task-diagnostics.ts` | state generation gate；升级错误写专用 journal，不回写 legacy state |
| agent/host job 启动 | `createLiveTask` → `reserveHostTask` → `attachAgentProcess` | process generation fence + active marker 双检查 |
| sync/merge/restore/provider 写 | `src/workflow/dispatch.ts` 统一入口 | generation gate 在动作分发前执行；后台回调仍由 persistence/fence 兜底 |
| repositoryId | `src/infra/repository-identity.ts` | plan 固定候选 ID；apply 内竞争发布；赢家不同则授权失效 |
| upgrade journal/config backup/staging/marker | Slice 2 durable adapter | same-directory temp + fsync + atomic publish/replace + parent fsync |
| state/config destructive rename | Slice 2 cutover/recovery | lock + fence + journal intent + rename + parent fsync + read-back + done |

## 对抗性验证

- 每个 file write/fsync、publish/rename、directory fsync、journal replace 前后可确定性注入失败。
- 双进程竞争 upgrade lock；owner token 保留进程启动标识用于审计，但 stale 回收只接受 `ESRCH` 明确死亡，活 PID 的启动字符串不匹配一律不抢。
- fence 建立前后同时尝试启动 ClickVibe task，均不得越过线性化点。
- fence 必须由宿主关闭 legacy start entry、再次确认入口仍关闭，并独立枚举操作系统进程；无法证明时只允许离线升级。活 PID 即使启动时间字符串不匹配也不可抢锁。
- cold backup 按原 inode、文件数、字节数和目录内容 hash 回读；旧进程长开 fd 污染 rename 后 backup 时不得写 `verified`。
- preview/apply 之间修改 config/state/repository/worktree 任一输入，apply 必须回到 previewed 且零准备写入。
- 成功、prepare 失败、cutover 失败、resume、rollback 后对 Git worktree/refs/dirty bytes 做前后快照比较。
- journal 缺失/损坏且出现 backup/staging/schema-1/v0.2 证据时进入 `manual-recovery-required` 只读 inventory；不得假装首次升级，也不得覆盖原始损坏 journal。
