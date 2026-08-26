# ClickVibe

> **v0.1.0 状态:**这是一个基本可工作的实验性开发者预览版,不是生产稳定性承诺。能力边界、已知限制与升级预期见 [v0.1.0 Release Notes](https://github.com/ai-daming/clickvibe/blob/v0.1.0/docs/releases/v0.1.0.md)。

> 在 DeepSeek Harness(DSH)Web 里开一个右侧面板,把你 GitHub 仓库的 open issue 变成一条看得见、点得动的开发流水线:选项目、看依赖、一键下单,Codex/Claude 在独立 worktree 里开发、review、返工；满足策略与门禁时可继续自动合并，异常才交还给人。

## 它是干什么的

ClickVibe 是一个 DSH Web 插件,给**「让 AI 帮你写代码」这件事补上最后一块拼图:状态与指挥**。

装上之后,DSH 侧栏底部会出现一个 **ClickVibe** 按钮,点开是一个项目面板:

- **选一个 GitHub 仓库**,所有 open issue 按里程碑 / 依赖关系分组铺开;
- **每一行就是一个工单**:当前进度、约定分支、被谁阻塞(blockedBy)、下一步该干什么——一眼扫完;
- **点一下按钮**,Codex 或 Claude 就在这个 issue 专属的 worktree 里开始开发;
- 开发完成自动进入 review,不过关按意见返工；过关后按项目/任务策略自动合并或等待确认。

人负责定义目标、架构慢变量和自动化策略，ClickVibe 负责工程闭环；证据不足或超出策略时才请求介入。它是一个 **local-first、GitHub-native、BYO-agent 的 Issue-to-Merge 交付控制面**——把「人不在电脑前的时间」变成「有效开发时间」:

> 人在路上/开会/睡觉,ClickVibe 按策略把代码写好、review、返工并推进到合并或明确暂停。

## 愿景:随身交付平台

ClickVibe 想成为的最终样子,是一个**随身携带的交付平台**:不管你在哪、手边是什么设备,像聊天一样就能查进度、下开发单、验收拍板;代码在远端无人值守地施工,该你决定的时候它来找你。

「人不在电脑前的时间 = 有效开发时间」这句话,今天说的是"睡觉时电脑还在跑";往后它想说的是:**你在哪,指挥所就在哪**。

这条路最后会走成什么样,现在没人说得准——所以这里不写路线图,只记方向。

## 为什么会有它

给 AI 下开发单这件事本身不难,难在下面三件事,ClickVibe 就是为它们做的:

1. **状态靠猜,是反复出事故的根源。** 以前开发/审查流程里,worktree 和主干脱节、review 结论不知道针对的是哪个 commit、按钮该不该点全凭记忆——来回折腾才发现「哦它其实卡在这了」。所以 ClickVibe 把 **git / GitHub 当成唯一事实源**,任何时刻只推导出**一个**「下一步动作」:开发、恢复、同步、Review、返工、合并,绝不存在「两个按钮都能点」的歧义。

2. **「人在场」的 agent 工具,解决不了「人不在场」的需求。** 常见的 agent 编排器管的是「人在时,一群 agent 并行干活」;但真实需求往往是你不在电脑前:代码该有人写,review 该有人盯,依赖图该有人排。ClickVibe 管的不是「agent 干活」,而是 **「需求从 issue 到合并的完整旅程」**——异步施工、全程无人值守、状态可推导可审计。

3. **机器可以执行，但不能自证正确。** Agent 可以使用 git/gh、解决冲突和推进 PR；ClickVibe 必须重新观察 exact HEAD、契约、Review、CI 与 GitHub 结果。常规 PR 可按显式策略自动合并，release/deploy 和证据不足的例外仍交给人。

一个佐证:这个仓库自己的功能(#5 权威状态视图、#7 项目优先面板等)就是 ClickVibe 自己开工单、自己开发、自己 review 合进来的(PR #15 / #19)。

## 用了以后,你可以干什么

**1. 一张图看清整个仓库的施工进度**
选一个 repo,所有 open issue 按里程碑或依赖分组,按依赖就绪/阻塞过滤。每一行自带:状态徽章、约定分支、落后提示、blockedBy 和唯一动作按钮。组内「就绪 → 开发中 → 被阻塞 → 已交付」排序,**永远先看到现在能下什么单**。

**2. 一键下单,无人值守开发**
点「开始开发」,ClickVibe 自动做好一切:从远端默认分支创建独立 worktree 和分支、启动 Codex/Claude 非交互开发。最长可跑 24 小时,随时可停;超时/断线后点「恢复开发」优先续上同一个会话,会话已失效时自动在原 worktree 降级为一次全新会话,未提交改动不会丢。

运行中的输出按 Codex/Claude 各自事件格式渲染成 TUI:命令、输出、思考、工具调用与 ClickVibe 系统提示分层显示,并展示运行时长和流中可得的 token 用量。输出可以 detach 到桌面浮窗或手机全屏,连接恢复后继续接收同一条事件流;任务结束后收进历史输出。

**3. 自动 review,按意见一键返工**
开发完成 → 自动进入 review,agent 对照验收标准和架构契约审查代码；**结论自动发到 PR/issue 评论**,并标注它审查的是哪个 commit。没过则按意见返工；过了以后按策略自动合并或停在待确认。

**4. 状态永远可信,不用猜、不用刷新**
权威状态视图实时对比 worktree / main / 远端三方哈希与领先落后;落后了提示你并一键同步(fetch + merge)。合并冲突不再回滚现场:冲突状态原样保留,交给返工 agent 先解决冲突、再修 review 意见,流水线不会死锁(#26);review 结论过时了会标注「已过期」,不会拿旧结论冒充当前状态。PR 合并了立刻显示「已交付」,不会还停在一个过期的合并按钮上。

**5. 没把握时,先「安全演练」**
怕链路没配好?点「安全演练」走完整流程,但 agent 只执行 `pwd`、`git branch`、`git status`,零代码副作用,验证完再放心下单。

**6. 人只处理慢变量和例外**
业务提单仍只需目标 / 验收标准 / 依赖；进入 coding 前由工程侧完成架构影响分级。人负责 L2/L3 设计、自动化策略和 release/deploy，常规施工、冲突与满足门禁的合并不要求重复点击。

## 快速开始

```sh
# 1. 安装到 DSH profile(本机路径)
dsh plugin --profile web add link:/path/to/clickvibe

# 2. 配置 ~/.clickvibe/config.yaml
```

```yaml
repos:
  ai-daming/clickvibe: /Users/me/work/clickvibe   # owner/repo → 本机路径

worktreeRoot: ~/.clickvibe/worktrees
fetchTtlSeconds: 45  # 查看状态时自动 fetch 的 TTL，可配置为 30–60 秒
```

```sh
# 3. (开发者)构建与测试
pnpm install && pnpm run build
pnpm test
```

重启 `dsh web` 后,在侧栏底部点 **ClickVibe** 打开面板,选项目,点「开始开发」即可。client 端改动硬刷新浏览器(⌘⇧R)即可生效。

## 对话触发:动作命令化

面板按钮不是唯一入口——每个操作都有一条纯文本命令,可在对话中触发(为手机端「对话优先」铺路):对话 agent 把「把 #8 下单开发」翻译成严格命令,发给 `POST /clickvibe/api/command`,由**与面板按钮完全相同的后端动作**执行。

```sh
curl -s http://127.0.0.1:3080/clickvibe/api/command \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3080' \
  -H 'x-clickvibe-request: 1' \
  -d '{"command":"status #8 ai-daming/clickvibe"}'
```

- 读命令(`status` / `issues` / `projects` / `help`)直接返回可读文本;
- 写命令(`develop` / `review` / `rework` / `resume` / `merge`)是两阶段:先返回预览与一次性授权(2 分钟),用户在对话里确认后携带授权重发同一命令才执行——与面板「预览 → 确认」同构,合并门禁不可绕过;
- 全部命令清单与语法见 [docs/command-reference.md](docs/command-reference.md);对话 agent 侧的 Skill 见 [skills/clickvibe/SKILL.md](skills/clickvibe/SKILL.md)。

## 在路上的能力(open issues)

| 方向 | 内容 |
|---|---|
| 手机端 | [#14](https://github.com/ai-daming/clickvibe/issues/14) 手机对话优先界面(碎片时间看状态/下单/验收)、[#13](https://github.com/ai-daming/clickvibe/issues/13) 所有操作命令化、可被对话触发 |
| 规模化 | [#11](https://github.com/ai-daming/clickvibe/issues/11) 跨机器执行、[#9](https://github.com/ai-daming/clickvibe/issues/9)/[#10](https://github.com/ai-daming/clickvibe/issues/10) 按依赖图自动选取、并行多工位调度 |
| 更跟手 | [#12](https://github.com/ai-daming/clickvibe/issues/12) 右侧占位式布局(PR #24)、[#8](https://github.com/ai-daming/clickvibe/issues/8) 提 issue 模板引导 |
| 更可靠 | [#3](https://github.com/ai-daming/clickvibe/issues/3)/[#17](https://github.com/ai-daming/clickvibe/issues/17) 长任务断线/中断恢复、[#18](https://github.com/ai-daming/clickvibe/issues/18) 超时上限可配置、[#20](https://github.com/ai-daming/clickvibe/issues/20) 提示词自带需求快照、[#22](https://github.com/ai-daming/clickvibe/issues/22) review 结论文件化不被截断、[#4](https://github.com/ai-daming/clickvibe/issues/4) 交付/审查评论流水、[#23](https://github.com/ai-daming/clickvibe/issues/23) 合并后自动清理 |

## 给维护者

### 代码结构门禁

- `src` 的 TypeScript/TSX 文件以 500 个物理行为常规上限；500–800 行必须在 `scripts/file-size-exceptions.json` 记录原因和跟踪 Issue，超过 800 行无条件拆分。
- `src/infra → src/github → src/agent → src/workflow` 依赖只能从上层指向同层或下层；`src/index.ts` 是合成根，客户端 `src/client` 不得导入宿主模块。运行 `pnpm run check:layers` 验证。
- 推导、映射和格式化保持纯函数；shell、文件、网络、时间和进程句柄集中在适配层。完整原则见 [架构说明](docs/architecture.md)。
- 本地交付链：`pnpm run typecheck && pnpm run build && pnpm test && pnpm run coverage && pnpm run lint && pnpm run format:check && pnpm run check:size && pnpm run check:layers`。`pnpm run fmt` 只用于本地写入格式，CI 使用只读的 `format:check` 拒绝噪音 diff。

- [当前有效架构](docs/architecture.md):系统边界、数据流、事实源、自动化、可观测性和 ADR 入口
- [产品演进路线](docs/roadmap.md):v0.2.0 至 v0.10.0 的版本主线和退出标准
- [循环监督与 Observer](docs/architecture/observer-intervention.md):Coding/Review 停滞检测、DSH Runtime Observer 与协议演化边界
- [状态模型](docs/state-model.md):事实分级、按钮决策表、软事实降级链
- [命令参考](docs/command-reference.md):全部可命令化操作、两阶段确认协议、安全边界
- [Issue 契约](docs/issue-contract.md):可自动开发的 issue 怎么写(目标/验收/依赖)
- [产品蓝图](docs/product-blueprint.md):定位、架构演进、设计约束
- [设计文档与调研](docs/plans/):布局改造、dry-run 等实施前设计

### Review 结论与历史恢复

Review agent 会把结构化结论写到 worktree 的 `.clickvibe/review-result.json`。完成回调优先读取并严格校验这个文件；文件缺失、过大、不是普通文件、JSON 损坏或 schema 不符时，会在 `~/.clickvibe/state/<issue-key>/review.log` 记录原因，再依次回退 stdout JSON 和表情结论。该文件已被 git 忽略，且每次 review 启动前都会删除，避免上一次结论污染新一轮 review；因此不要手工预置它。

当前一轮开发与 Review 的状态行完整保存在 `~/.clickvibe/state/<issue-key>/dev.log` 和 `review.log`；新一轮同类型任务启动时重置对应日志，避免多轮任务无限累积，跨轮摘要保留在 workflow events。面板先读取磁盘历史，再从返回的 cursor 连接 SSE 增量；Host 重启后仍能恢复历史，移动网络切换时 EventSource 会按事件序号续传。排障时可直接查询：

```sh
curl 'http://127.0.0.1:3080/clickvibe/api/history?taskId=<task-id>'
curl 'http://127.0.0.1:3080/clickvibe/api/history?key=<issue-key>&kind=dev'
```

对 #19/#12 这类旧版本已截断的结论，先从 `~/.clickvibe/state/<issue-key>.json` 读取 `reviewAgent`、`reviewSessionId` 与 `reviewSessionAgent`，必要时只在归属匹配的 Claude `~/.claude/projects/**/*.jsonl` 或 Codex `~/.codex/sessions/**/*.jsonl` 中定位原会话。不要直接篡改 workflow JSON：旧结论必须绑定它实际审查的 commit。将 worktree 恢复到需要审查的 HEAD 后，在面板使用同一 reviewer 执行「重新 Review」；ClickVibe 会续接归属匹配的精确 session、要求 agent 从原会话上下文复核问题并物化新结论，新的 review 事件会记录本次实际 HEAD。若归属未知、不匹配或原 session 已不存在，只能发起一次全新 review，不能跨 agent 续会话，也不能把无法验证 commit 的旧文本冒充当前结论。

## 安全说明

真实 Agent 只接受**本机回环、同源、带专用请求头**的请求启动;启动前会冻结并展示当前 Issue 快照,签发**一次性、两分钟过期**的授权。不要把面板暴露到局域网或公网——它不把同账号进程隔离当作安全边界。
