# 命令参考:动作命令化(issue #13)

ClickVibe 的每个操作都有一条**纯文本命令形式**,可在对话中触发(「把 #8 下单开发」),UI 按钮只是入口之一。命令入口是 `POST /clickvibe/api/command`,它转发给与面板按钮**完全相同**的后端动作和安全门禁——不存在第二套实现。

对话中的自然语言由对话 agent 翻译成下表的严格命令;服务端只认严格语法,不做模糊猜测。解析器(`src/command.ts`)接受中文动词别名,并自动剥离「把/请/帮我/用/一下」等语气词,所以「把#8下单开发」「用 claude 把 #8 下单开发」直接可用。

## 全部可命令化操作

| 命令 | 中文别名 | 说明 | 写操作(需确认) |
|---|---|---|---|
| `help` | 帮助 | 列出全部命令 | 否 |
| `projects` | 项目 | 列出 `~/.clickvibe/config.yaml` 配置的项目 | 否 |
| `issues [repoKey]` | 列表 / 工单 | 列出项目 issue、依赖阻塞与下一步动作 | 否 |
| `status <目标>` | 状态 / 看状态 / 进度 | 某 issue 的权威状态(分支/PR/review 结论/下一步) | 否 |
| `develop <目标> [repoKey] [codex\|claude] [context=…]` | 下单开发 / 开始开发 / 开发 | 下单开发,创建 worktree 并启动 agent;附加说明拼入 prompt(首次开工仍记「开发」) | 是 |
| `develop <目标> dryrun`(或 `安全演练 <目标>`) | 安全演练 | 走完整流程但零代码副作用 | 否(仅回环校验) |
| `/clickvibe auto <目标> [dev=codex\|claude] [review=codex\|claude] [rounds=N] [budget=H] [merge=on\|off]` | 自动跑到底 / 自动推进 | 开发→建 PR→Review→返工循环;默认 20 轮/24 小时并停在待合并 | 是(一次确认绑定完整配置) |
| `review <目标> [repoKey] [codex\|claude] [context=…]` | 审查 | 启动 review,结论发 PR/issue 评论;附加说明拼入 review prompt | 是 |
| `rework <目标> [context=…]` | 返工 / 按意见返工 | 按 review 意见返工(自动带上意见) | 是 |
| `resume <目标> [context=…]` | 恢复 / 恢复开发 | 恢复中断的开发会话 | 是 |
| `sync <目标>` | 同步 / 同步基线 | worktree 同步远端基线并推送 | 是(免授权,仍校验来源) |
| `stop <目标>` | 停止 | 停止该 issue 运行中的任务 | 是(免授权,仍校验来源) |
| `merge <目标>` | 合并 | 合并 PR、清理 worktree/分支、关 Issue、归档 | 是(人的决策,必须明确确认) |
| `merge <目标> override=<放行原因>` | — | 合并门禁拒绝后的人工放行(跳过项+原因写入审计,不绕过 GitHub 保护) | 是 |

**目标**写法:`#8`、`8`、完整 issue URL(`review` 也接受 PR URL)。配置了多个项目时必须带 repoKey(如 `develop #8 ai-daming/clickvibe`);只有一个项目时可省略。

## 请求与响应

```sh
curl -s http://127.0.0.1:3080/clickvibe/api/command \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3080' \
  -H 'x-clickvibe-request: 1' \
  -d '{"command":"status #8 ai-daming/clickvibe"}'
```

- 读命令直接返回:`{ ok: true, action, text, ... }`,`text` 是对话中可直接展示的可读文本。
- 写命令(`develop/auto/review/rework/resume/merge`)是**两阶段**的,与面板「预览 → window.confirm → 执行」同构:
  1. **预览**:首次发送返回 `{ ok: true, needsConfirmation: true, text, authorization }`。`text` 是确认提示(冻结快照/PR 目标/清理范围),`authorization` 含一次性 `authorizationId` / `authorizationDigest`(2 分钟有效)。服务端自己冻结 Issue 快照,不信任调用方回传。
  2. **执行**:用户在对话中明确确认后,携带 `authorizationId` / `authorizationDigest`(merge 还需 `target`)原样重发同一命令。执行前服务端会再次校验快照未变,变了则拒绝并要求重新预览。
- `sync` / `stop` / dryrun 不需要一次性授权,但仍要求本机回环 + 同源标记请求头。
- `merge` 被 ClickVibe 门禁拒绝时,响应会带全部失败项(`gateFailures`)与可读清单;用户逐项确认后可用 `merge <目标> override=<放行原因>` 重新预览——放行绑定**当时实际失败项**,执行前会重新收集门禁,新增失败项不被旧确认覆盖(同 issue #49 的面板放行协议)。

## 安全边界(与面板完全一致)

- 写命令(含预览签发)要求:本机回环地址、`Origin` 与 `Host` 同源、`x-clickvibe-request: 1` 标记。安全门禁在任何配置读取之前。
- 一次性授权绑定精确动作 + 快照,2 分钟过期,消费即失效;篡改 context/agent/auto 配置重发会被拒。
- merge 门禁(review 哈希一致、验收契约未变)在共享的后端动作里,命令入口无法绕过。
- 不要把面板/命令入口暴露到局域网或公网。

## 与 UI 的关系(设计约束 1)

`/command` 不重新实现任何动作:它把解析出的命令转发到与 UI 按钮相同的 `handleApiPost` 分发(`src/index.ts`),因此授权协议、任务门禁、状态推导、评论发布全部共享。新增操作时:在 `WRITE_METHOD`/读命令分支注册映射,并更新本文件与 `src/command.ts` 的 `COMMAND_HELP_TEXT`。
