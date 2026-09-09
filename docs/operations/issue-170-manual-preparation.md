# #170 未决准备的离线人工结算

依据：[ADR-0018](../architecture/decisions/0018-manual-worktree-preparation-resolution.md)。Owner：维护者；触发点：出现跨 runtime 的 dispatched 或需人工处理的 blocked。执行每次另行授权。本规程不会恢复旧任务或增加自动恢复额度。

## 1. 静止、独立备份与结束证据

选定已审查的源码 SHA，使用 Node ≥22 的 TypeScript 支持运行下方脚本；本仓库验证环境为 Node 26。记录该 SHA。先停止 DSH、禁用所有自动重启入口，并退出可能写入同一仓库的 Agent、编辑器后台任务和终端命令。保持维护窗口单操作者独占。PID 查无记录不代表旧写入者已结束。

重启前记录本机启动标识（命令只输出主机与启动事实的摘要）：

```sh
node scripts/manual-preparation.mjs boot-id
```

维护者单独授权重启本机；重启后不启动 DSH 或仓库写入者，再运行同一命令记录新标识。两者必须不同。若事故发生前的启动标识无法对应到旧写入者所处的启动周期，不能补造旧标识。远端执行、共享/网络文件系统、无法枚举的写入者或不能证明安全的 hook 不适用。

在私有目录保存独立备份：当前 config、recovery journal、state marker、该工作项的完整目录（workflow、诊断、附件及任务历史），以及 Git 注册/HEAD/状态记录。使用复制而非 hardlink/symlink，保持权限，逐文件计算 SHA-256 并回读；不得覆盖原有备份。记录备份位置、清单及实际停止方法，供维护者审核。不要 reset/stash/clean/remove，也不恢复旧 state 根目录。

## 2. 制作证据并预览

在私有 `evidence.json` 中写入下列字段；权限必须为 0600。布尔值是维护者依据实际现场作出的声明，不是脚本能自动证明的事实。将备份清单和停止/重启/本机标准 Git 证据保存在同一私有证据目录，reason 中说明其位置和清单哈希。不要填写 token、命令凭据或原始输出。

```json
{
  "operator": "维护者姓名",
  "reason": "本次人工核查结论，以及私有备份/现场证据清单的位置和 SHA-256",
  "beforeBoot": "重启前保存的真实标识",
  "afterBoot": "重启后当前真实标识",
  "allWritersStopped": true,
  "restartDisabled": true,
  "localStandardGitOnly": true,
  "exclusiveWindow": true,
  "backupComplete": true
}
```

从备份的 workflow.json 读取精确 key；不要根据目录名称猜。原文件须为私有、独立普通文件。指定一个尚不存在且父目录私有的计划目录：

```sh
node scripts/manual-preparation.mjs preview /absolute/home EXACT_WORKFLOW_KEY /private/evidence.json /private/new-settlement-plan
```

脚本只写私有 original.json、target.json、manifest.json，不写活 workflow/Git。它检查版本配对、配置和准备身份、完整 OID、注册、分支、干净工作区、Git 操作中间状态、hook 和未决任务/写事务。为避免猜测，任何仍保留的 task/hostJob 凭据、remoteGitAttempts 或 delivery 都拒绝，转人工核查，不在此规程中清除。旧任务引用即便看起来已结束，也不能删掉来迎合检查。

脚本输出计划 fingerprint。维护者核对原文件副本与现场哈希，并审查 target.json 的全部差异：只准许 ADR-0018 §3 的字段变化。原 attemptId、runtimeInstanceId、冻结 OID、历史和恢复额度必须保留；`kind=note` 是现有 WorkflowEvent 中 ADR 所称 note 类型的实际字段名。

## 3. 精确授权、发布与回读

先授权本次 fingerprint，才运行：

```sh
node scripts/manual-preparation.mjs publish /private/new-settlement-plan EXACT_FINGERPRINT /private/evidence.json
```

同目录临时文件 fsync 后，脚本再次核查现场、证据、配置配对和原 workflow；匹配才原子替换并 fsync 目录。与状态同次发布人工 note，推进 revision 和任务代次，标为 settled，保持 devInterrupted 和 autoRun 暂停。它不创建 verified、不补额度、不执行 Git 写命令。

完成后回读活 workflow 与 target.json 的字节一致性，核对 note、任务代次、settled、暂停和旧额度。保留三个计划文件及 fingerprint。

## 4. 中断、失败与恢复

保持宿主和写入者停止，用同一 fingerprint、证据和目录再次执行 publish。原值在则只重试本次状态发布；新值在则只回读；其它值、证据变化、Git/config 漂移全部拒绝。不要改 manifest/hash 来让检查通过。发布后不恢复旧 workflow 备份，以免重新激活旧权限。磁盘失败保留计划与现场，修复存储后再执行同一计划。

如果准备结算后启动业务产生了变化，不能再拿旧计划“回滚”或重做。dirty、额外提交、归属冲突、活任务或其它未决写事务都转单独核查，不能自动清理。

## 5. 新授权与现场验收

重新启动宿主后先确认工作项仍暂停，旧自动运行不启动。对原目标和冻结基线申请新授权；正常 prepare 重新核对 settled 现场、写 verified，claim 再消费记录。观察 Git add/switch/remove 没有重放、旧任务代次不能认领、原恢复额度未被人工规程清空。任何现场变化继续暂停。

- [ ] 精确源码 SHA、维护者、实际停止方式、重启前后证据与独立备份已记录。
- [ ] fingerprint 授权和原/目标全差异核对、实际发布与回读完成。
- [ ] 重启后暂停、新授权和不重放验收完成；记录执行时间与证据。

自动测试只验证临时 HOME、真实 Git/文件系统及模拟的旧启动证据；不代表本机已真实重启，也不替代此现场验收。
