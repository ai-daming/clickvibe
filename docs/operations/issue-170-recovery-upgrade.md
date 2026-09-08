# #170 离线升级与现场验收

设计：[ADR-0016](../architecture/decisions/0016-shell-worktree-recovery.md) + [ADR-0017](../architecture/decisions/0017-recovery-state-root-isolation.md)。Owner：维护者，已在 #170 设计讨论中接受升级与现场验收责任。
触发点：维护者决定发布 #170 的已审查实现版本。本文不是现场执行授权；下列 pending 项未完成不得启用。

## 发布前

- [ ] 实现 PR 的 exact head 已审查，工程门禁及覆盖率通过；记录旧/新代码 SHA。
- [ ] 确认维护窗口，停止旧 DSH 并禁用自动重启，确认旧 Agent 和前台 Git/Shell 命令已退出。仅父进程退出不够；无法确认时不传 host-stopped 声明。
- [ ] 保留当前 config、原升级 journal、旧 state 与 Git/worktree 现场；不执行 reset/stash/worktree 清理。

## 预览与授权

在要发布的 Git 源码 checkout 中运行（不要用未确认版本的任意安装目录）：

```sh
node scripts/upgrade-recovery-1.mjs preview --home /absolute/operator/home --plan /private/upgrade-plan.json
```

该命令只写显式指定的私有计划文件，默认拒绝覆盖已有文件。终端输出 fingerprint、文件数与目标位置，不输出历史内容。
计划包含源/目标文件清单与哈希、引用转换、当前 Git 注册/HEAD/工作区状态摘要及配置模板；不会嵌入全部任务历史。

- [ ] 核对计划的 home、新目录 `state-recovery-1`、仓库身份、Git 现场、备份路径及转换范围。
- [ ] 维护者明确授权该 fingerprint，才可执行下面的 apply。

```sh
node scripts/upgrade-recovery-1.mjs apply --plan /private/upgrade-plan.json --fingerprint EXACT_FINGERPRINT --host-stopped host-stopped-and-restart-disabled
```

fingerprint 错误不执行转换；有效回显记入 `~/.clickvibe/recovery-authorization.log`。
机器先重查源文件与 Git 场景，再备份、构造 staging、验证契约引用、切配置、发布新根、回读并记 verified。
旧 state 原样保留，不建兼容链接，不双写。新运行时只读取新根；未经完成的升级不能启动业务。

## 中断与回滚

保持宿主停止、确认进程静止后，使用同一计划与 fingerprint：

```sh
node scripts/upgrade-recovery-1.mjs resume --plan /private/upgrade-plan.json --fingerprint EXACT_FINGERPRINT --host-stopped host-stopped-and-restart-disabled
node scripts/upgrade-recovery-1.mjs rollback --plan /private/upgrade-plan.json --fingerprint EXACT_FINGERPRINT --host-stopped host-stopped-and-restart-disabled
```

resume 根据实际文件哈希推进，不能覆盖漂移内容；终态 resume 仍验证当前配置/新根配对。
rollback 只允许未开始新业务且新/旧现场未漂移的情况。发生新业务写入后不得恢复旧备份降级，需发布当前格式的修复版本。
源文件、Git 场景或 staging 漂移时，保持宿主停止并核查差异；不要删除 journal、强改 fingerprint 或重跑覆盖。

## 启用与验收

- [ ] 核对 verified journal、新 config/marker 的 fingerprint；新旧根无 symlink/hardlink；历史与契约 raw bytes/fingerprint 可读。
- [ ] 启动新宿主，确认旧自动运行暂停，新的自动运行需要新授权。
- [ ] 一个真实工作项验证：正常启动；命令异常显示类别/信号/超时/耗时；敏感输出省略；工作区保存失败不删除已创建现场。
- [ ] 验证一次冷却恢复后再次同类三连失败会停机；停止/过期/替换授权不能启动旧动作；旧运行的迟到错误不消耗新运行额度。
- [ ] 原事故若未复现，明确记录“防护已验证，原始因果未证明”，不得把测试场景当成原事故结论。
- [ ] 回填现场证据与执行日期后，由维护者决定 #170 关闭。发布、升级、验收和关闭分别记录。
