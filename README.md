# ClickVibe

> 在 DeepSeek Harness(DSH)Web 里开一个右侧面板,把你 GitHub 仓库的 open issue 变成一条看得见、点得动的开发流水线:选项目、看依赖、一键下单,Codex/Claude 在独立 worktree 里开发、review、返工自动跑——你只负责拆 issue 和拍板合并。

## 它是干什么的

ClickVibe 是一个 DSH Web 插件,给**「让 AI 帮你写代码」这件事补上最后一块拼图:状态与指挥**。

装上之后,DSH 侧栏底部会出现一个 **ClickVibe** 按钮,点开是一个项目面板:

- **选一个 GitHub 仓库**,所有 open issue 按里程碑 / 依赖关系分组铺开;
- **每一行就是一个工单**:当前进度、约定分支、被谁阻塞(blockedBy)、下一步该干什么——一眼扫完;
- **点一下按钮**,Codex 或 Claude 就在这个 issue 专属的 worktree 里开始开发;
- 开发完成自动进入 review,不过关按意见返工,过关后你确认合并。

人负责「下订单」和「验收」,中间(开发 → review → 返工 → PR)全程自动、无人值守。用我们自己的话讲,它是个**里程碑驱动的异步开发执行器**——把「人不在电脑前的时间」变成「有效开发时间」:

> 人在路上/开会/睡觉,ClickVibe 在家把代码写好、review 完、PR 挂起来,等你回来拍板。

## 愿景:随身交付平台

ClickVibe 想成为的最终样子,是一个**随身携带的交付平台**:不管你在哪、手边是什么设备,像聊天一样就能查进度、下开发单、验收拍板;代码在远端无人值守地施工,该你决定的时候它来找你。

「人不在电脑前的时间 = 有效开发时间」这句话,今天说的是"睡觉时电脑还在跑";往后它想说的是:**你在哪,指挥所就在哪**。

这条路最后会走成什么样,现在没人说得准——所以这里不写路线图,只记方向。

## 为什么会有它

给 AI 下开发单这件事本身不难,难在下面三件事,ClickVibe 就是为它们做的:

1. **状态靠猜,是反复出事故的根源。** 以前开发/审查流程里,worktree 和主干脱节、review 结论不知道针对的是哪个 commit、按钮该不该点全凭记忆——来回折腾才发现「哦它其实卡在这了」。所以 ClickVibe 把 **git / GitHub 当成唯一事实源**,任何时刻只推导出**一个**「下一步动作」:开发、恢复、同步、Review、返工、合并,绝不存在「两个按钮都能点」的歧义。

2. **「人在场」的 agent 工具,解决不了「人不在场」的需求。** 常见的 agent 编排器管的是「人在时,一群 agent 并行干活」;但真实需求往往是你不在电脑前:代码该有人写,review 该有人盯,依赖图该有人排。ClickVibe 管的不是「agent 干活」,而是 **「需求从 issue 到合并的完整旅程」**——异步施工、全程无人值守、状态可推导可审计。

3. **机器不该替你做关键决策。** 版本能不能发、PR 要不要合并,是核心决策权。ClickVibe 把自动化停在「开发/review/返工/同步」,把 merge 和发版留给**你亲手确认**。

一个佐证:这个仓库自己的功能(#5 权威状态视图、#7 项目优先面板等)就是 ClickVibe 自己开工单、自己开发、自己 review 合进来的(PR #15 / #19)。

## 用了以后,你可以干什么

**1. 一张图看清整个仓库的施工进度**
选一个 repo,所有 open issue 按里程碑或依赖分组,按依赖就绪/阻塞过滤。每一行自带:状态徽章、约定分支、落后提示、blockedBy 和唯一动作按钮。组内「就绪 → 开发中 → 被阻塞 → 已交付」排序,**永远先看到现在能下什么单**。

**2. 一键下单,无人值守开发**
点「开始开发」,ClickVibe 自动做好一切:从远端默认分支创建独立 worktree 和分支、启动 Codex/Claude 非交互开发。最长可跑 24 小时,随时可停;超时/断线后点「恢复开发」续上同一个会话,worktree 里的改动不会丢。

**3. 自动 review,按意见一键返工**
开发完成 → 自动进入待 review → 你点 Review,agent 对照验收标准审查代码;**结论自动发到 PR/issue 评论**,并标注它审查的是哪个 commit。没过 → 点「按意见返工」,带着全部问题续会话改;过了 → 你确认合并。

**4. 状态永远可信,不用猜、不用刷新**
权威状态视图实时对比 worktree / main / 远端三方哈希与领先落后;落后了提示你并一键同步(fetch + merge)。合并冲突不再回滚现场:冲突状态原样保留,交给返工 agent 先解决冲突、再修 review 意见,流水线不会死锁(#26);review 结论过时了会标注「已过期」,不会拿旧结论冒充当前状态。PR 合并了立刻显示「已交付」,不会还停在一个过期的合并按钮上。

**5. 没把握时,先「安全演练」**
怕链路没配好?点「安全演练」走完整流程,但 agent 只执行 `pwd`、`git branch`、`git status`,零代码副作用,验证完再放心下单。

**6. 你只需要在两个时刻出现**
拆 issue(目标 / 验收标准 / 依赖,三行就够,写法见 [issue 契约](docs/issue-contract.md))和验收决策(点合并、拍板发版)。中间一切由 ClickVibe 自动施工。

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
```

```sh
# 3. (开发者)构建与测试
pnpm install && pnpm run build
pnpm test
```

重启 `dsh web` 后,在侧栏底部点 **ClickVibe** 打开面板,选项目,点「开始开发」即可。client 端改动硬刷新浏览器(⌘⇧R)即可生效。

## 在路上的能力(open issues)

| 方向 | 内容 |
|---|---|
| 手机端 | [#14](https://github.com/ai-daming/clickvibe/issues/14) 手机对话优先界面(碎片时间看状态/下单/验收)、[#13](https://github.com/ai-daming/clickvibe/issues/13) 所有操作命令化、可被对话触发 |
| 规模化 | [#11](https://github.com/ai-daming/clickvibe/issues/11) 跨机器执行、[#9](https://github.com/ai-daming/clickvibe/issues/9)/[#10](https://github.com/ai-daming/clickvibe/issues/10) 按依赖图自动选取、并行多工位调度 |
| 更跟手 | [#16](https://github.com/ai-daming/clickvibe/issues/16) TUI 实时输出 + 放大 detach + 运行时长/token、[#12](https://github.com/ai-daming/clickvibe/issues/12) 右侧占位式布局(PR #24)、[#8](https://github.com/ai-daming/clickvibe/issues/8) 提 issue 模板引导 |
| 更可靠 | [#3](https://github.com/ai-daming/clickvibe/issues/3)/[#17](https://github.com/ai-daming/clickvibe/issues/17) 长任务断线/中断恢复、[#18](https://github.com/ai-daming/clickvibe/issues/18) 超时上限可配置、[#20](https://github.com/ai-daming/clickvibe/issues/20) 提示词自带需求快照、[#22](https://github.com/ai-daming/clickvibe/issues/22) review 结论文件化不被截断、[#4](https://github.com/ai-daming/clickvibe/issues/4) 交付/审查评论流水、[#23](https://github.com/ai-daming/clickvibe/issues/23) 合并后自动清理 |

## 给维护者

- [架构与状态模型](docs/state-model.md):事实分级、按钮决策表、软事实降级链
- [Issue 契约](docs/issue-contract.md):可自动开发的 issue 怎么写(目标/验收/依赖)
- [产品蓝图](docs/product-blueprint.md):定位、架构演进、设计约束
- [设计文档与调研](docs/plans/):布局改造、dry-run 等实施前设计

## 安全说明

真实 Agent 只接受**本机回环、同源、带专用请求头**的请求启动;启动前会冻结并展示当前 Issue 快照,签发**一次性、两分钟过期**的授权。不要把面板暴露到局域网或公网——它不把同账号进程隔离当作安全边界。