# 自动化与信任

> Status: Accepted | Parent: [当前有效架构](../architecture.md)

## 顶层原则

ClickVibe 的目标不是“所有 GitHub 操作都要人确认”，而是：

> 可恢复、可验证、策略内的工作自动完成；不可逆、证据不足或超出策略的工作停止并升级。

Agent 必须拥有完成任务所需的实际工具，包括编辑、测试、git 和必要的 gh 操作。不给工具却要求 Agent 自主解决同步、冲突和 PR 协作，是自相矛盾的设计。

但“Agent 能执行命令”不等于“Agent 的判断自动成为事实”。ClickVibe 仍需重新观察 HEAD、PR、Review、CI 和合并结果。

## 权限与决策分离

| 能力 | 默认执行者 | 生效条件 |
|---|---|---|
| 编辑、测试、commit | Coding Agent | 限定 Issue/worktree，保留完整输出 |
| fetch、merge baseline、解决冲突 | Coding Agent / workflow use case | 不覆盖未知现场；完成后重新 review |
| push、创建/更新 PR、评论 | Agent 或控制器 | 目标冻结；写后回读；失败保留原始证据 |
| Review | 独立 Review Agent | 绑定 exact HEAD、Issue 契约和验证证据 |
| merge PR | ClickVibe merge use case | 项目/任务策略允许，全部门禁通过，match exact HEAD |
| release/deploy | 独立策略域 | 不由普通 Issue merge 权限自动推出 |

提示词和 gh wrapper 不是安全边界。真正的强边界来自：GitHub branch protection、required checks、最小权限凭证、精确 HEAD 匹配、ClickVibe 门禁和写后回读。

## 自动合并策略

v0.1 已支持显式开启 auto-merge，但产品文档长期把“merge 必须人点”写成永久原则，这是过期设计。目标架构的正式原则如下；v0.3 落最小可执行 Policy，v0.7 完成完整策略治理：

- 项目或本次任务没有授权自动合并：收敛到 `ready-for-merge`，等待人。
- 已授权自动合并且所有事实 current：由 ClickVibe 调用同一 merge-and-cleanup use case。
- 任何 override、stale evidence、unknown、required check 不满足或非等价门禁失败：自动化不得越过，转为明确暂停。
- 合并成功必须回读 GitHub `MERGED` 和目标 ref，随后执行可重入清理。

## 人应该在哪里出现

- 定义业务目标、验收和 Non-Goals。
- 接受或拒绝 L2/L3 架构设计。
- 配置项目级自动化和合并策略。
- 处理证据不足、权限不明、业务合同变化、反复无进展或真正不可逆的例外。
- 决定 release/deploy 等高于单 PR merge 的动作。

人不应该因为普通文案修改、可恢复冲突或已经满足全部门禁的常规 PR 被迫重复点击。

## 循环介入策略

Coding 和 Review 都处于交付循环内部：Coding 的激励是通过 Review，Review 的激励是继续发现问题。自动化不能指望二者自行发现“方法本身没有收敛”，因此 v0.3 起每轮 Review 落盘后由 Controller 的纯规则 Loop Guard 核对：

- Review 明确输出 `stop-and-redesign`：立即停止自动返工。
- 同一 CRITICAL 母题连续两轮复发：立即停止自动返工。
- 连续三轮 Review 未通过：在进入下一轮前停止。
- 修复 diff 连续两轮增长且高优问题集合未缩小：停止。
- 人显式要求暂停或观察：永远允许，不需要满足量化阈值。

轮数是兜底，不是“无进展”的唯一含义。具体阈值属于版本化项目策略，可在后续基于真实复盘调整；“模型不能自触发”“Observer 期间冻结同一 workflow”“判决绑定完整证据快照”是不可变边界。

v0.3 停止后进入最小 `human-required`，保存原因、最低完整证据和明确下一步。v0.6 才把证据查看、指令修改和受控恢复做成面板体验；模型数据证明有效且策略启用 Runtime Observer 时，允许在人工介入前执行一次只读诊断和一个验证轮。相同母题再次出现、Observer 无法验证关键 finding、需要扩大权限/改业务合同，或介入预算耗尽时，转为 `human-required`，禁止 Coding/Review 继续互相打转。

Runtime Observer 默认只读：可以读取代码、Git 历史、Review、测试和任务日志并运行验证命令；不能修改业务代码、直接合并或自动修改全局 prompt/Skill/门禁。跨任务重复出现的协议候选交给独立 Protocol Observer，按普通架构变更流程进入设计、Review 和合并。
