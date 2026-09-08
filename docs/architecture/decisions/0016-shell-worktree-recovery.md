# ADR-0016：Shell 诊断、工作区准备恢复与有限重试

Status: Accepted（维护者已接受第二版；依 ADR 索引规则，合入 main 后才成为实施基线）
Date: 2026-09-09
Work: https://github.com/ai-daming/clickvibe/issues/170
Code baseline: `777364e4c95f10cce18efdff529467b9602879d6`
Design acceptance: 维护者在本任务中对第二版设计及离线升级/降级限制明确回复“没问题，继续”。
Accepted source SHA-256: `e3a87d411126f2aadc01074b27084569933540af68689452c7250adc04d8d552`。
本 ADR 从 main 独立整理，不依赖尚未合入的 #169 / ADR-0014、0015。

## 1. 目标、权限与决定

让命令失败能够解释；有效工作区不因控制器保存失败被删除；证据充分时恢复，持续失败有确定终点。
本 ADR 只定义设计，不携带实现、现场配置变更或升级执行。实施前须满足仓库设计合入与 impl-gate；现场升级仍须精确 preview 授权。

| 类型 | 决定 |
|---|---|
| 用户确认 Q1=A | 工作区归属、初始版本、无其他任务占用均可证明时自动恢复；否则保留现场并暂停等人 |
| 用户确认 Q2=B | 首次同类三连失败后允许一次冷却恢复；再次同类三连失败停止自动重挂 |
| 固定 | 手动与自动共用准备路径；未知不能当成功或死亡；不自动合并；错误落盘且可展示，凭据不落盘 |
| 第二版已接受 | 恢复额度属于一次自动运行，只有新的人为授权才重建额度；成功推进可清连续错误计数，但不能补回已消费额度 |
| 非目标 | 全局 Shell 队列、跨机器执行、v0.3 Policy/Lease/Envelope、自动清理历史现场、变更 GitHub 限流策略 |

Q1/Q2 先确认产品边界，第二版接受覆盖下述机制、离线升级及降级限制。缺失运行事实不作为默认成功。

## 2. 当前证据与推断边界

- `src/infra/runtime.ts:300`：runCommand 只返回文本；非零退出只拼 exitCode/stdout/stderr，忽略原因字段。
- `src/workflow/develop-start.ts:209` 加进程内 workflow lock；`auto-run.ts:277` 直接调用 ensureWorktree。
- `src/infra/workflow-persistence.ts`：现有命令队列、跨进程 link lock、revision 与任务代次凭证；锁只覆盖持久化命令不等于覆盖整个 Git 准备。
- `src/agent/worktree.ts:311` 与 `tests/worktree-integration.test.ts:140`：首次准备后保存失败，会回滚删除新分支/工作区。
- `auto-run-recovery-policy.ts`：当前三次熔断、五分钟冷却、每小时最多十次重挂；fingerprint 取 stack，恢复时会清计数。
- 本地 DSH 源码 HEAD `d347e703908d0406b7a7ef80e3a0e594d86b2215` 的 ShellRunResult 有 signal/timedOut/aborted/timeoutMs；run 的基础设施异常走 reject。
- 2026-09-09 查本机 active diagnostics，fingerprint `121f9214` 命中 0 条。web profile 的 clickvibe 链接指向本仓库；链接不证明事故进程加载版本。
- Issue 无后续评论或设计回执。事故根因与当时实际宿主版本仍未验证。后续恢复只能证明恢复发生，不能证明并发导致故障。

Accepted 来源：architecture.md、authority-model.md、state-model.md、ADR-0007/0009/0011/0012/0013。保留三访问平面及唯一诊断通道。

## 3. Shell 原因与证据契约

输入由调用点明确传入工作流身份、稳定 operation 类别和本次调用关联 ID；不得从完整命令推测身份。
分类顺序：明确 timedOut → timeout；明确 aborted → abort；明确 signal → signal；宿主基础设施 reject → host-shell-failure；其余 null → unknown。相互矛盾字段归 unknown 并保留矛盾摘要。
普通非零退出保持 command-failure。分类只解释宿主原因，不代表 Git 副作用未发生。
resolve/run 的同步或异步异常均通过同一规范化入口记录；未知字段记 unavailable，不编造取消者或杀进程原因。
记录请求与生效 timeout、开始/结束/耗时、终止原因、输出是否截断；stdout/stderr 各最多保留 4 KiB 的已脱敏尾部，完整敏感输出不另存。
动态输出和时间仅用于诊断，不进重试 fingerprint。稳定身份用 operation + classification + 标准化 errorCode/signal；不使用完整 stack、路径或输出文本。
按调用类别允许输出字段；无法安全脱敏的片段整体省略并标明 omitted，不宣称正则能识别所有 secret。永不记录 stdin/env/凭据参数，命令仅记录类别。
复用 DiagnosticRecord、correlationId、共享 JSONL writer 与面板投影；详细安全字段放入现有 rawArtifact(kind=diagnostic)，具体生命周期见 §7.3。
诊断持久化失败必须有可观察 fallback；要求持久证据的恢复/停机转换不能在写失败后继续派发。
runCommand 不自动重放写命令；重试属于工作流层，先回读副作用。

## 4. 工作区准备、认领与恢复

### 4.1 状态最小集合

新增一个工作流内的准备记录，复用现有持久化 writer，不建平行日志数据库。
记录包含 schema、attemptId、准备状态 prepared/dispatched/settled/verified/blocked、repo 身份/common-dir、规范目标路径与分支、完整 base OID、原任务代次、开始前 Git 事实和拟执行的有限操作。
attemptId 标识一次准备，不是授权；实际写权限必须来自锁内验证后签发的临时凭证。时间不决定接管权。
生产者为准备入口；消费者为正常完成、崩溃恢复与任务认领。verified 记录保留到认领完成，不能在外部写完成而工作流尚未确认时删除。
基线字段直到 verified 才公开生效；prepared 里的 OID 只是待确认意图。

### 4.2 正常路径

1. 两个入口进入同一准备准入机制。先完成必要 remote fetch，再取得准备互斥；不在持久化锁内等待 Remote Git 队列。
2. 锁内重读 workflow revision/任务代次/宿主占用/Git 现场。running 或 unknown 禁止准备写动作。
3. 精确冻结完整 OID，持久化 prepared 意图并回读。持久化失败则零 Git 写入。
4. 持有准备权限派发一次 Git 操作，等待命令完成；锁/权限失效后禁止继续派发。
5. 回读 common-dir、工作区注册、目标路径、分支与 OID，验证后通过条件持久化同时写入 baseRef 与 verified。
6. 任务认领必须在相同准入规则下消费 verified 记录，重查当前任务状态；认领与开始准备不能穿插。未知、取消或代次改变一律拒绝。

### 4.3 失败路径

- 命令结果未知：保留 dispatched，不因 null 判“尚未执行”；仅按 §4.4 的结束证据规则回读/结算。
- Git 完成、保存失败：保留现场与最后已持久状态（通常为 dispatched），不执行 force remove/branch -D；不启动 Agent。
- prepared 表示未授权派发，只有 Git 完全符合操作前事实才可派发；settled 加 Git 目标回读一致可补记 verified。跨 runtime 的 dispatched 不适用自动重派，见 §4.4。
- 部分成功、额外提交/dirty/conflict、归属不符或旧写入者生死未知：blocked，保存证据和明确人工下一步；不自动清理或采用。
- 没有准备记录的遗留现场不享有本协议的自动接管权；仍遵守既有正常 reuse 契约，但不能凭目录存在把未确认准备升级为成功。
- 不跨 repo 串行化独立任务；同一 workflow、同一目标路径的冲突必须拒绝或串行化。Git 自身锁不替代整个准备事务。

### 4.4 互斥与结束证明：revision 2 决定

复用 workflow-persistence 的单一命令队列和同一 workflow 文件锁，新增有限的“准备事务”入口，持锁覆盖 Git 观察、意图写入、派发、回读与准备结算。不是另加一把同工作流的独立锁。
准备事务回调只拿事务内的条件读写方法，不能重入公开 commit/claim/appendEvent 方法。I/O 编排仍放 infra，纯恢复决策独立。
Remote fetch 在事务外；事务内只使用已经存在的完整 OID，不等待 Remote Git/Gateway 队列。baseline restore 保留按 workflow 路径排序的多锁顺序。
其他 prepare、stop、claim、completion 继续经过同一持久化锁，因此准备结束后才可修改该 workflow。prepare 不持锁等待 Agent 执行。
准备取得锁后总工作预算 120 秒，每次命令使用剩余预算与原 timeout 的较小值；超时发取消并等待返回，但绝不把超时等同“进程已停止”。不能确认命令结束则记录 dispatched/blocked，释放锁后所有新写动作先检查该记录并拒绝。
锁等待超时返回可读 busy，不计入 Shell 同类故障；stop 遇 busy 返回“尚未停止”，不能假报成功。其后重试依旧串行；正常准备的取消代价是等待当前准备退出。

准备结束后与任务认领不需要一直持锁：verified 记录绑定 taskStateRevision；claim 在原文件锁内检查该记录、最新停止状态与宿主占用，并消费它。任何 stop 都必须使准备凭证失效，即使尚无 taskId，也推进受保护的任务代次。新的人工授权才能解除 stopped/blocked；正常未停止的自动流程可使用原授权继续。
自动入口只准备/配置，不虚构 Agent 认领；真正 develop/review/resume 的 claim 均检查未决准备阻塞。宿主 reservation 只占位、不能先运行 Agent；claim 未成功必须撤销本次占位，取消占位失败保留 unknown 并阻止新认领。sync、merge、baseline restore 和清理也不得绕过 dispatched/blocked 记录。诊断追加不受此业务阻塞，但仍受版本围栏。
签发的临时准备凭证只在事务内有效；内部派发及结算方法要求该凭证并比对 attemptId/任务代次。普通 metadata patch 不能更改准备状态或受保护的恢复额度。
不同 workflow 的目标路径碰撞必须在配置加载时枚举全部绑定的派生路径规则并拒绝（包括同 basename 仓库）；准备时固定并回查配置哈希，配置变化即重新授权；Git 占用检查作为第二道验证。相同 repo 下正常不同目标并发保留，不新设全仓 Shell 队列。

**结束证据：** 每条写命令前先持久 dispatched，run 返回后记录结果并回读 Git，成功持久 settled 后才能进入 verified。prepared 明确表示尚未允许派发；dispatched 的缺失返回不能被推成失败或成功。
同一 runtime 内若命令已明确结束而保存失败，可持有内存结果重试保存；跨 runtime 只有完整 settled 记录且 Git 回读相符才能恢复。只有 dispatched 的重启现场一律保留并暂停，不按 PID 死亡或冷却超时自动接管。
Shell 的前台结束不证明任意后台 hook 已退出。自动补存/恢复只适用于可验证无有效 post-checkout hook、无自定义后台派发的准备调用；hook 状态不可确认时进入 blocked，保留既有 hook 行为，不擅自禁用 hook。确认 hook 的解析包含 core.hooksPath、默认 hooks 路径与执行权限；错误为 unknown。
外部操作者不受本锁强制约束，因此每次回读还必须核对注册、路径、branch、完整 OID 和 dirty/conflict；变化则 blocked。系统不宣称可防御任意不合作外部进程在检查后修改 Git。

这种方案不依赖新增 DSH API。本地 DSH subprocess-local 在 macOS 的 fallback 明确不能保证逃逸后代退出（packages/subprocess/subprocess-local/src/index.ts），进一步支持 dispatched 重启后不自动接管的边界。

## 5. 有限重试

权威状态位于现有 autoRun 记录；计数、恢复额度和停机结果由条件提交持久化，内存 timer 只是唤醒器。
扩展恢复记录语义：当前稳定 failureKey、consecutive、retryAt、cooldownUsed、halted。限流使用既有独立路径，不能覆盖或重置本额度。
为防交替错误补充循环漏洞，总预算/原有退避上限继续有效；不新增多错误历史表。

| 输入 | 转换 |
|---|---|
| 同类失败第 1/2 次 | 保存连续计数与退避时刻；保存成功才安排下一次 |
| 第 3 次且 cooldownUsed=false | 保存冷却状态与五分钟 deadline |
| 冷却到期 | 重查预算、停机/取消、占用和恢复证据；条件写 cooldownUsed=true 后，才允许派发一次恢复 |
| cooldownUsed=true 后同类再次连续 3 次 | 持久 halted，paused/controller-error；watchdog、普通 reconcile 均不得解除 |
| 人工停止/明确取消 | 停止，不作为瞬时故障自动重启 |
| unknown 写入结果/占用 | 只允许有界只读观察，不能重放写入；到预算或证据无法证明安全时暂停 |
| 已验证实际进展 | 只清 consecutive/failureKey；不清 cooldownUsed/halted |
| 控制器重启/普通观察成功 | 不清任何额度；由持久记录恢复 |
| 新人工授权 | 重新观察并建立新的自动运行，可重新分配额度；不能借普通刷新重置 |

实际进展定义为：本次失败所阻塞的动作完成其权威回读和条件状态提交。仅查询成功、定时器运行、空 reconcile 不算进展。
在派发前消费额度意味着崩溃可能浪费一次机会，但不会多发；这是 fail-closed 的明确代价。

## 6. 算法与状态双向追踪

| 转换 | 读 | 写 | 决策/串行化 | 失败结果 |
|---|---|---|---|---|
| 准备准入 | Git/任务事实、revision | prepared | §4.4 同一工作流持久锁 | 零派发/blocked |
| 准备结算 | 意图、Git 回读 | verified + baseRef | 同一准备权限，条件提交 | 保留现场 |
| 恢复接管 | 意图、旧执行者终态、Git | verified/blocked | 相同准入机制 | unknown 不接管 |
| Shell 规范化 | 宿主返回/异常 | DiagnosticRecord | Shell adapter + 共享 writer | 明确 unknown/fallback |
| 自动恢复 | 持久计数/额度/预算 | cooldownUsed/halted | workflow 条件提交 | 不派发 |

| 结构 | 生产者 | 生产消费者 | 生命周期 |
|---|---|---|---|
| 准备记录 | 准备准入 | 恢复、结算、认领 | prepared→verified/blocked→认领完成后收尾 |
| 临时准备凭证 | 锁内验证 | Git 派发/结算 | 持锁有效，失锁/取消/代次变化失效 |
| 恢复计数及额度 | 故障处理 | watchdog/reconcile/人工授权 | 同一次 autoRun 内持久；新授权替换 |
| 安全错误证据 | Shell adapter | 面板、诊断者 | 共享轮转和保留策略 |

## 7. 兼容、发布与回滚：revision 2 决定

> 本节的共用状态根目录、替换旧 marker 和“旧版全部拒写”假设由 [ADR-0017](0017-recovery-state-root-isolation.md) 替代；其余范围依 ADR-0017 §8 解释。

旧程序会删除 controllerRecovery、忽略新增准备记录，不能把新增字段称为安全的可选扩展。采用一次离线格式升级，保持现有 Work Item 身份、路径、Git 现场和历史记录，不做 clean break 或丢弃旧 state。
格式：config schemaVersion=2；state marker schemaVersion=2、generation=v0.2-recovery-1；原 v0.2 journal 保留原样。新增本次离线升级 journal，schemaVersion=1，独立描述 prepared/config-written/marker-written/verified 状态和原/目标文件哈希、备份清单、授权 fingerprint。
本 ADR 明确授权此次格式设计与升级协议，不能借用 ADR-0009 的一次性 clean-break 授权。合入后实施仍须 impl-gate；现场执行仍须操作者授权本次精确计划。

### 7.1 为什么旧版不能悄悄写

旧 loadConfigFromHome 明确拒绝 schemaVersion=2。旧 assertActiveStateWriteAllowed 在原 journal=verified 且新 marker 不被识别为 v0.2 时拒绝写入。
但已加载旧进程可能命中内存 v0.2-active 快路径，所以升级只允许宿主停止且重启被禁用的离线模式；不能宣称仅换 marker 能封住任意存活旧进程。
实施须静态枚举所有 active writer 并以旧 baseline 真代码测试拒写；未通过就不发布。旧二进制直接启动应报不兼容，不能自动恢复旧配置。
新程序仅在本次 journal verified、config/marker 的计划 fingerprint 匹配、schema 受支持时准入；任何半升级或未知结构一律禁止业务派发和写入。不得保留进程内“永远放行”的缓存分支。

### 7.2 离线转换顺序

1. preview 只读盘点：精确运行文件哈希、原 config/state marker/journal、全部 workflow 哈希、现存 Agent/宿主/可识别 Git 进程与注册工作区；生成不含 secret 的计划摘要及完整计划 fingerprint。
2. 操作者确认宿主停止且自动重启禁用；存在活任务、未决外部写或无法证明进程结束则不 apply。人工声明不能把已观察到的活进程覆盖掉。
3. 持全局升级互斥，重读盘点哈希，要求与授权一致；原 config/state/journal 完整备份并逐项校验，写本次 prepared journal。备份失败零转换。
4. 将 config 原子替换为 schema 2，使新启动旧版先拒绝；再转换 workflow、替换 marker，最后原子提交 verified journal。每步先记录意图、写临时文件、同步文件、rename、同步目录并回读哈希；不删除原备份。
5. workflow 既有字段保留，新增准备记录初始为 absent；所有转换文件及原/目标哈希固定在计划 manifest，逐文件 intent/applied 状态记入同一升级 journal；旧 paused/fused/controllerRecovery 不能猜剩余额度：标为 legacy-unknown/halted，需新人工授权。已有 autoRun 保留历史并暂停，不自动继承旧授权运行。
6. 新运行时严格配对加载、读到所有旧历史、未知状态拒写后才允许启动；新业务运行须新授权。转换不改 branch/worktree/commit、remote 或 Issue。

崩溃恢复由离线 runner 根据 journal、实际文件哈希决定：目标吻合则前进，原值吻合则重做该原子步，其他值停止只读报告；不能依据 journal 的预期值覆盖漂移文件。
verified 前回滚：宿主仍停止，逐项确认现值属于本次计划后恢复备份，config 最后恢复；校验通过后记 rolled_back。漂移拒绝覆盖。
verified 后回滚：仅允许证明从未发生新业务写入（所有计划内文件哈希仍为转换后值且无新增业务文件）的零使用回滚。发生过新写入则禁止降级，采用当前格式的修复版本；不得恢复旧备份抹掉进度/恢复额度。此限制明确接受易维护性优于自动降级。

### 7.3 详细字段和诊断落点

准备记录 schema=1，attemptId 为随机 ID；runtimeInstanceId 仅用于限制同实例补存；expectedTaskStateRevision 为非负整数；baseOid 为 Git 返回的完整对象 ID而非 short hash；paths 规范化并绑定 repositoryId/common-dir。
steps 为本次已选择恢复分支的有限命令序列，每项固定 operation、before/expectedAfter Git 事实、dispatchState=prepared/dispatched/settled、exitCode/signal/classification。index 只能在上项 settled 且回读满足预期后推进。未知版本/缺字段/越界状态 blocked。
首次选择对应 1 次 add 或 switch；repair 只处理确认的空/不存在目标注册，逐步记录 remove/add，任何非空变化停止，不把 force remove 当恢复捷径。
verified 记录在 claim 原子消费时删除，保留摘要 WorkflowEvent；blocked 不自动过期或删除。普通复用必须重新生成并验证本次记录，不重用已消费的凭证。
恢复额度使用独立的 autoRun.recoveryBudget={schema:1,runId,cooldownUsed,halted}；runId 在新授权建立，回调绑定 runId 后在锁内写。当前 controllerRecovery 保留错误/退避状态，清除它不再删除额度；限流路径不得修改 recoveryBudget。
所有 manual resume/start-auto 请求也必须重新授权才能解除 halted；普通 watchdog、面板轮询和 generic metadata 不具备解除权限。
细节诊断使用现有 rawArtifact(kind=diagnostic,redaction=applied)，存储有界、已脱敏 JSON；共享 artifact 哈希规则验证；DiagnosticRecord.message 提供独立可读摘要，rawArtifact 丢失仍展示摘要及证据缺失。读取仅允许任务目录内已验证路径，禁止任意文件读取。
同目录引用 artifact 与对应诊断轮转共同保留；删除必须在共享 writer 的轮转串行化内确认活动及保留轮转文件均无引用，不能删除未发布/未决恢复所需证据。准备恢复依赖 workflow 内 steps，不依赖可轮转诊断文件。

## 8. 验证与交付门禁

- Shell：真实 timeout、主动 abort、signal、自发信号、spawn reject、未知/矛盾字段；脱敏和截断；动态文本不改变 failureKey。
- Git：真实临时仓库；写成功但保存失败、进程中断、prepared 先落盘后零派发、额外提交/dirty/conflict、遗留无凭证现场。
- 并发：两个入口同时准备、prepare 与 claim/stop 交错、两进程争用、父死子活、旧回调；不同工作流独立完成。
- 重试：首次三连、一次冷却、再次三连停机；重启不重置；只读观察不清零；持久化失败零派发；额度消费后崩溃不补发。
- 证据：每一失败分类通过真实共享 writer→reader→面板投影验证；不另造计量流水线。
- 兼容：旧运行时不能覆盖新记录；未知版本 fail-closed；回滚不抹掉 unresolved 准备和停机额度。
- 工程：TDD，真实 Git/最小协议 fake；全量 typecheck/build/test/coverage≥85%/lint/size/state-writes 等现有门禁。
- Issue AC1/3/7 对应 §3；AC2/4 对应 §4；AC5 对应 §5；AC6 对应本节；AC8 仍要求授权 PR、独立 review、人工 merge。

## 9. 替代方案与代价

只补日志：风险最小且有 Accepted 诊断依据，但不能冒充完成 AC2/4/5。
所有失败都等人：机制更简单，不满足已选择 Q1。
全局 Shell 队列：扩大故障域，不能解决崩溃与未知副作用，不采用。
选定方案保留现场与有限重试：可自愈，但增加持久准备状态、部署兼容成本，且未知旧子进程会保守停机。

## 10. 接受记录与发布责任

| 项目 | 结论/必要结果 | 门禁 |
|---|---|---|
| 事故原始证据 | 本机未找到；不宣称已证明事故根因。当前机制以独立源码缺口和可复现故障窗口立项，不要求用户猜宿主版本 | 事故根因声明；关闭时须标明是否只完成防护而未复现原事故 |
| 准备互斥/子进程恢复 | §4.4 已定义；未知 dispatched 重启不接管，无宿主增强依赖 | 设计接受与实现测试 |
| 状态与兼容 | §7 已定义；离线升级、旧版拒写、零使用回滚限制已获维护者接受 | 设计合入与实现准入；现场执行另行授权 |
| 发布责任 | 维护者（本任务用户）已明确接受离线升级与现场验收责任，原话“由我（维护者）负责，发布时再授权执行” | 未取得精确计划授权不得执行升级 |

待执行发布清单：Owner = 维护者（本任务用户），责任于 2026-09-09 确认。触发点 = 维护者决定发布 #170 实现版本；逐项完成前禁止升级启用。执行时回填日期与证据链接，当前全部 pending。
- [ ] 维护者确认具体维护窗口，记录旧/新 artifact SHA，确认停止与禁用自动重启的方法。
- [ ] 旧 baseline 拒写、半升级恢复、实际场景回归与全部工程门禁通过。
- [ ] preview/hash/备份 read-back 完成，操作者明确授权该计划。
- [ ] apply、配对加载、历史保留与旧二进制拒写验证通过，否则保持宿主停止并按 §7 恢复。
- [ ] 一个真实工作项验证安全恢复和最终停机；保留原始证据，明确原事故是否复现；手动 review/merge 不变。

修订记录：第二版已获维护者接受；正式化时统一 §4.3 与 §4.4 的 prepared/dispatched/settled 用词，不改变“未知不接管”的已接受规则。发布 owner 已确认；设计接受、设计合入、实现 READY、发布授权与现场验收分别记录。
