# ADR-0017：恢复状态使用独立目录

> Status: Accepted（Q3=A 已确认；分支标签仅在审查合入 main 后生效）
> Date: 2026-09-09 | Owner: ClickVibe maintainers | Work: #170
> Supersedes: ADR-0016 §7 的共用状态根目录及“旧版全部拒写”假设；其余决策继续有效。
> Code baseline: b92f150fb3019d6f9eddf5633826feb74100dbb8

## 1. 证据、用户决定与边界

ADR-0016 假定 schema 2 config 和新 marker 能让旧版本全面拒写。冻结旧代码的测试表明：配置读取会拒绝，但规范诊断与契约发布不检查该围栏，旧插件 apply 也会注册路由。这不证明原事故原因或任意 HTTP 路径会修改恢复额度。
维护者在本任务明确选择 Q3=A：允许新状态使用独立目录，优先将改动限定在 ClickVibe。Q1 安全证据充分时恢复、Q2 一次冷却机会与最终停机、维护者负责发布及逐次升级授权均保持。
本 ADR 不再要求任意旧内部 API 在人为指定新目录时自动拒写，也不要求已经存在的旧二进制改变启动行为。验证目标是：支持的旧运行时默认路径不能读取或改写新控制状态。
不增加 DSH 插件、全局进程监管、文件系统访问控制或两套同时权威的状态。运行相同账号的任意代码、手工改路径和恶意修改文件不在此隔离承诺内。

## 2. 唯一根目录与生产消费者

| 对象 | 固定位置/规则 | 生产消费者 |
|---|---|---|
| 旧状态 | `~/.clickvibe/state/`，保留现场及独立备份 | 仅旧运行时/离线迁移/人工历史取证；新 active runtime 不读取 |
| 新状态 | `~/.clickvibe/state-recovery-1/` | 新 workflow、任务/动作日志、契约、诊断、归档、恢复记录的唯一 active root |
| 公共 config | `~/.clickvibe/config.yaml`，schema 2 | 新 runtime loader；旧 config reader 明确拒绝 |
| 新 marker | 新根目录下 `.clickvibe-state.json`，schema 2、generation=`v0.2-recovery-1`、planFingerprint | 新 loader 与每个新 active writer |
| 本次 journal | `~/.clickvibe/upgrade-recovery-1.json` | 离线 runner 与新 root 配对校验；不是第二份业务状态 |

新 stateRoot(home) 是唯一应答源；所有默认 reader/writer 从同一个无 I/O 的固定路径函数获得它。运行时不提供可选 root 配置，不在 absent/unknown/invalid 时回退旧路径。
infra 的显式 root 参数继续支持隔离测试及离线迁移；生产组合根只能注入新 root。workflowStatePath、stateDir、历史和归档枚举、契约/诊断 reader/writer、预算持久化、版本围栏逐个静态枚举；旧路径字面量仅允许在离线迁移与历史协议中。
新配置/根目录不存在时，UI 可显示“尚未升级”，但不得建立空状态开始任务或自动初始化目录。未知 marker、损坏 journal、计划配对失败均禁止业务派发。新类型/字段验证继续依 ADR-0016。
旧原始 journal 和旧 marker 不替换、不伪造“新升级成功”；也不提供旧根到新根的 symlink、hardlink 或双写同步。

## 3. 目录隔离与备份约束

源、目标和 staging 均须以 realpath/父目录身份确认归属预览中的 ClickVibe home；目标必须是不同根，不能是源的子目录或反向嵌套。源/目标端点或内部符号链接、非普通文件、无法读取的条目在 preview 阻断，不默默跳过。
新目标在 preview 时须不存在；出现已有目标只允许进入本次 journal 的恢复路径，不能覆盖。staging 使用本次 fingerprint 下的独立目录；不得复用其他尝试的 staging。
源文件采用字节复制创建新 inode，不采用 hardlink。校验源/目标文件 inode 不共享（在同设备时），目标无符号链接和多链接文件；目录不可互相别名。旧根保持不变，不会因迁移成功自动删除。
备份保存 config、原 journal、旧状态的完整文件集合及逐文件哈希。备份与目标也不能共享可写 inode。源在备份前后变化则计划失效；旧进程仍活动时不执行迁移。
这是支持的运行时路径隔离，不能阻止用户主动把新目录作为旧 writer 的显式 root 参数。

## 4. 引用迁移与不可变证据

不得对全文做字符串替换。离线转换器只改以下有语义的路径字段，并将每个源/目标文件哈希、转换类别和引用映射写入同一个 plan manifest。

| 数据类别 | 转换 | 验证 |
|---|---|---|
| 契约 `captures/<id>/raw.json` | 原字节复制 | SHA-256 不变；captureId 不变 |
| 契约 `snapshot.json.rawArtifact.path` | 重定位至新根同一 capture 的 raw.json | 用真实契约 reader 验证路径、raw hash、fingerprint；不得改变 canonical 契约 |
| 契约 `current.json` | 同一 captureId/fingerprint 原值保留 | 新根 reader 可读取 known bundle |
| workflow/task/事件中的 Git 路径、Issue URL、会话 ID | 原值保留 | 不把 Git 工作区路径当作状态路径改写 |
| workflow 自动运行控制 | 按 ADR-0016 暂停旧自动运行，旧额度未知则 halted，需新授权 | 新 runtime 不继承旧自动授权；原 workflow 备份完整 |
| 规范 DiagnosticRecord 的 rawArtifact | 只有引用源根内部、哈希有效且类型受支持的 artifact 才复制并重定位 | 真实新根 reader/安全 artifact reader 可读取；contentHash 不变 |
| 无 artifact 的诊断及 task log/历史原始行 | 字节保留 | 历史文本中的旧路径作为证据保留，不作为 active locator 解析 |

所有历史 capture 都迁移，不只迁移 current 指向的一个；archive 和轮转诊断也纳入 manifest。未知格式或声明了无法安全迁移的 active artifact 引用时 preview 阻断并报告类型/位置，不能假装历史已完整迁移。
rawArtifact 存在但对应原文件缺失的记录保留原始摘要，转换为无可访问 artifact 的诊断，并追加 source-ref-missing 的迁移诊断；原引用只留在冷备份证据中，转换后的 active reader 绝不能回读旧目录。对契约 current 的必要 raw 缺失则阻断，而非清空引用。
staging 中的引用写最终新根路径。发布前通过专用只读验证视图将最终根映射到 staging 做同样的 hash/路径校验；发布后再用真实 active reader 全量验证，不能只检查文件存在。该映射仅是离线验证参数，不进入生产读取路径。

## 5. 切换算法与失败恢复

沿用 ADR-0016 的离线授权、备份、文件同步和 journal 机制，替换共用目录转换部分：

1. preview 盘点 config/原 marker/journal、全部源文件、Git/worktree 与任务活性；生成源与目标 manifest、精确转换结果哈希、目标路径及 fingerprint。发布 owner 必须确认旧宿主停止且重启禁用。
2. apply 取得现有离线升级互斥；重读来源集合和文件哈希，任何漂移拒绝。完成独立备份及校验后写 prepared journal，才能写转换结果。
3. 在 staging 建立新树，转换 §4 路径与自动状态，记录每个文件 intent/applied、同步并回读；原 source 根不动。不得发布半完成的新树。
4. 将 config 原子替换为 schema 2（使旧 config reader 拒绝）；将完整 staging 原子 rename 到此前不存在的新根；最后提交 verified journal。各步均记录 before/after hash 和 phase。
5. 新 runtime 在 verified 前不派发。verified 后重新验证 config、新 marker、journal fingerprint、必要 schema/根归属，真实读取迁移历史。可变业务文件不要求永远等于迁移时哈希；迁移 manifest 只用于恢复/回滚验证。
6. 验证通过后由维护者启宿主，新任务须重新授权；旧根不参与重启恢复、合并状态或后台同步。

journal schema=1，phase 为 prepared/staged/config-written/root-published/verified/rolled-back。manifest 记录每个相对路径的原/目标哈希、文件类别及转换规则版本；目标 config 与 marker 同 fingerprint 绑定，源旧 marker/journal 哈希进入授权计划。
计划 fingerprint = SHA-256(canonical UTF-8 JSON)，对象 key 排序、数组保持规范的相对路径排序；包含协议版本、固定绝对路径、源/备份清单、转换规则、计划内转换后的业务文件哈希及 config/marker 模板。模板中的 fingerprint 固定为空串参与哈希，禁止把自身最终 digest 再放回哈希输入形成循环。runner 算出 fingerprint 后填入模板，派生实际 config/marker bytes 与哈希；journal 保存这些派生值，reader 必须按计划重算而非相信 journal 声明。运行进度和回读结果不参与授权 fingerprint；来源变化必须重新 preview。

进度写和文件替换是分开的：崩溃后以实际源/目标文件集合及哈希判定。文件等于目标则补记进度，等于原值/目标缺失且 source 未漂移才重做；其他状态 unknown，停止并给出差异。恢复入口必须持相同离线互斥并检查宿主静止；不能靠 phase 断言覆盖文件。
若 config 已 schema 2 而新根未发布，新旧运行时都不能开始业务；离线 runner 完成或回滚。若新根已发布而 verified 未提交，回读成功后补记，不能启动第二份迁移覆盖它。

## 6. 回滚与共享 Git 边界

verified 前：确认新树/配置仍属于本次计划后，将目标移回本次 staging，恢复旧 config（最后恢复），原旧根无需回搬。只清理本次已证明拥有的临时路径，不删漂移现场。
verified 后：沿用 ADR-0016 的零使用回滚限制。只有 config、新树全量文件集合/哈希仍等于转换终态、旧源也未漂移，才能停机恢复原 config；有任何新业务写入则使用新格式修复版本，不丢弃进度降级。
旧运行时可能向旧根追加诊断，因此旧根不能视为不可变备份。若这种写入导致旧根漂移，零使用回滚也拒绝自动恢复，交维护者处理；独立备份仍可用于只读取证。
目录隔离不覆盖 Git/worktree 和共享 config。升级前必须确认旧任务结束；不得同时运行旧/新插件或将旧 config 恢复后运行旧任务。对现存任务、无法确认退出的进程或不明宿主活性均阻断；仅有父 PID 死亡仍不构成充分证据。
不承诺旧程序完全不能启动，也不以“旧版路由仍注册”单独阻断新状态迁移。若发布验收发现受支持启动路径能绕过停机/配置版本约束并执行共享 Git 副作用，则阻断启用并补充该具体路径的设计；不能将新目录探针冒充这项验证。

## 7. 算法/状态追踪与验证

| 算法 | 读 | 写 | owner / 失败 |
|---|---|---|---|
| root 选择 | 明确 home、固定版本 | 无 | 单一 root 函数；不回退 |
| preview/授权 | 源清单、引用、Git/任务活性 | 有界计划证据 | 离线 runner；unknown 阻断 |
| 转换 | 计划+源 exact bytes | staging、引用映射、进度 | 升级互斥；漂移拒绝 |
| 发布/恢复 | journal+实际文件哈希 | config、新根 rename、verified | 同一 runner；半态禁止业务 |
| 回滚 | 全量源/目标与终态清单 | 恢复 config、移走本次新树 | 维护者授权；已使用或漂移拒绝 |
| active 读取 | 新根 marker/config/journal | 新根业务状态 | 新组合根；缺失不读旧根 |

反向消费者：root 决定全部 active I/O；manifest 驱动转换/回滚；引用映射被契约/诊断 reader 消费；journal 控制启动准入与离线恢复。无独立双写对账库或长期迁移守护进程。

随文探针 `docs/baselines/issue-170-old-state-isolation-probe.mjs` 在未改动的 b92f150 source 上验证：
- 旧默认诊断/契约写入只改变旧根，新根所有文件哈希不变。
- 旧 workflow 枚举读不到新根停机记录；旧 config reader 拒绝 schema 2。
- 契约原字节复制会失败；正确重定位 ArtifactRef 后，原 raw bytes 和 canonical fingerprint 均保持且真实 reader 成功。

这 4 项已实测通过，只是可行性证据，不是升级实现、全量旧路由副作用隔离或现场验收。后续 TDD 必须覆盖目录别名/hardlink、损坏/缺失引用、全部历史 capture、每个 crash checkpoint、源漂移、旧根并发写、使用后回滚拒绝、所有新 reader/writer 不回退，以及共享 Git 准入路径。
原 `recovery-old-writer.test.ts` 的失败保留为旧假设反证；不得给旧源码打补丁后声称原断言通过，也不把不再成立的“全部旧 writer 必须抛错”转成新验收。

## 8. 发布交接与替代关系

维护者已在本任务接受发布/现场验收责任；具体窗口与精确计划仍另行授权。维护者决定发布 #170 时，ADR-0016 §10 的清单必须额外验证：独立目录无链接、历史引用可读、新旧根不互写、新 runtime 不回退、旧宿主与任务静止、共享 Git 入口不会绕过约束。未完成任一项禁止启用。
ADR-0016 §3–6 的恢复与重试规则、§7 中离线静止/备份/精确授权/新配置格式/零使用回滚原则及 §10 owner 继续有效。本 ADR 仅替代 §7 中目标与源路径相同、替换旧 marker、旧版全部拒写/拒注册的说法；冲突时本 ADR 优先。
替代方案：修改 DSH 加载器增加版本许可，需要跨项目发布，用户选择不优先采用；共用目录只加新 marker 已被探针反证；旧/新同步或兼容链接会重新引入共同写入面，不采用。
代价：迁移期间需要备份与新树的额外磁盘空间，历史引用必须验证，旧源漂移会阻断自动回滚。换取新控制状态不依赖旧二进制自觉检查版本。
