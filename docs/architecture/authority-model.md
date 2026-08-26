# 事实源与状态权威

> Status: Accepted | Parent: [当前有效架构](../architecture.md) | Detailed behavior: [状态模型](../state-model.md)

## 权威层级

| 事实 | 权威来源 | ClickVibe 本地记录的角色 |
|---|---|---|
| 文件、提交、分支、worktree、冲突 | 本地 Git | 快照和展示缓存 |
| 远端 refs、Issue、PR、Review、CI、merge | GitHub | 映射缓存与证据索引 |
| 当前宿主任务是否运行 | 当前进程 live handle + DSH `ctx.jobs` | task id、host job id 和租约 |
| 会话、事件、日志、自动策略、恢复线索 | `~/.clickvibe/state/` | 对此类 ClickVibe 自有事实具有权威性 |
| 下一动作 | 唯一 `deriveNextAction` 纯函数 | 不允许消费者自行推导 |
| 是否需要观察循环 | 纯规则 Loop Guard + 持久化 Review/交付证据 | Runtime Observer 不得决定自己何时启动 |
| Runtime Observer 诊断 | 绑定 evidenceHash 的 DSH 会话结果 | 是下一轮指令和审计证据，不是 Git/GitHub/CI 事实或权限授权 |
| Agent 是否完成 | Git/GitHub/测试/review 的重新观察 | Agent 声明只作为待验证输入 |

“Git/GitHub 是事实源”不表示本地状态没有价值。它表示：本地状态不能伪造 Git/GitHub 已经发生的事情；会话归属、租约和本地任务日志等 ClickVibe 自有事实仍由本地持久化与宿主监督器回答。

## 不变量

1. 缓存命中不能提升事实等级。
2. 缺失只能推出 `unknown`，不能推出任务死亡或动作成功。
3. Review 必须绑定 exact HEAD 与 Issue 契约指纹。
4. 写入返回成功不能替代写后回读。
5. 同一 workflow 的共享状态写入必须进入同一串行化命令域，并在锁内校验写凭证。
6. 一个问题只能有一个系统级应答源；UI、handler 和 Agent 不得各自推导。
7. 原始错误、动作和目标必须保留；分类标签不能替代证据。
8. Observer 判决只能作用于其冻结的 workflow generation 与 evidenceHash；输入变化后必须失效。

## 快照与缓存的区别

- **快照**：一次决策使用的冻结输入，保证本次 Decide 的内部一致性。
- **缓存**：跨请求复用的读取结果，只用于减少 I/O，必须有失效和强制刷新规则。
- **事件**：已经发生过的操作与观察证据，用于审计，不用于覆盖当前事实。
- **workflow**：ClickVibe 自有的会话、策略和租约状态，不是 Git/GitHub 镜像数据库。
