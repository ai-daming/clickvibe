# ClickVibe 状态模型:事实分级与按钮决策表

> 2026-08-22 讨论沉淀。回答一个问题:**"这个 issue 现在处于什么状态,下一步该做什么、显示什么按钮"** —— 判断必须只依赖客观、保证存在的事实,任何"可能缺失"的东西都只能当增强器,不能当门槛。
>
> 2026-08-22 增补(吸收 gh-issue 轻量版):review 结论额外绑定**契约指纹**(issue 目标/验收正文),正文被改 → 结论过期;自动写动作后**回读验证**。

## 一、核心原则

1. **git + GitHub 原生事实 = 判断的地基**。它们客观存在,不依赖任何人"记得写"。
2. **workflow 文件 ≠ 门槛**。它是缓存(worktree 路径其实可推导、会话 id、事件历史),缺失时判断必须照常工作,最多结论更保守。
3. **comment meta = 增强器**。允许缺失;缺失时走降级链(GitHub 原生 review → 人工确认),**永不因缺 meta 而卡死,也永不因缺判据而瞎猜**。
4. **入口从 GitHub issue 出发**:枚举 repo 的 open issue,用约定(config 的 repo 路径 + worktreeRoot + issue 号)算出候选 worktree/分支,再用 git 查真相;workflow 文件存在时只叠加缓存信息。

`workflow.autoRun` 同样只是可选的自动推进配置与审计缓存,不替代 git/GitHub 事实。字段缺失或结构无效时直接退回手动模式;`running` 只消费实时 `deriveNextAction`。Host 重启后若没有对应 live task,降级为 `paused / session-interrupted`,绝不从本地游标猜测下一步。

## 二、事实分级

| 级别 | 事实 | 来源 | 获取手段 |
|---|---|---|---|
| **硬** | issue OPEN/CLOSED | GitHub | `gh issue view` |
| **硬** | issue 契约正文(目标/验收,用于契约指纹) | GitHub | `gh issue view` 取正文算指纹 |
| **硬** | worktree 有无、registered branch | 本地 git | `git worktree list --porcelain` 交叉约定路径 |
| **硬** | 目标分支有无(本地/远端) | 本地 git | `git show-ref` / `for-each-ref` |
| **硬** | 内容更新(不管是否 commit) | 本地 git | `git status --porcelain` + `git log <fork点>..HEAD` |
| **硬** | 开发基线身份与最后已知 tip | 本地 git | `workflow.baseRef` 中不可变的远端分支与最近一次成功同步持久化的 hash |
| **硬** | 应同步基线(现在该是什么) | 本地 git | `baseRef` 对应 `origin/<branch>` 的当前 tip(默认 origin/HEAD) |
| **硬** | PR 存在 / open / merged / closed | GitHub | `gh pr list --head <branch>` + `gh pr view` |
| **硬** | GitHub 原生 review(APPROVED/CHANGES_REQUESTED/COMMENTED) | GitHub | `gh pr view --json reviews`(受控词表,字段保证存在) |
| **软** | review 结论(通过 + 问题列表) | 本地事件 / comment meta | 见降级链 |
| **软** | 结论绑定的 HEAD | 本地事件 / comment meta | 同上 |
| **软** | 会话 id + agent 归属(续会话用) | 本地(进程/文件) | 缺失/归属未知/跨 agent → 降级为全新会话 |
| **软** | 任务是否在跑 | 进程本地 | 唯一非 git/GitHub 事实,天然临时;可推导出"中断"结论 |
| **软** | comment meta(事件流水) | GitHub 评论 | 只影响时间线展示,不影响判断 |

## 三、按钮决策表(按优先级)

### P0 终端状态(一票否决)

| 状态事实 | 按钮 |
|---|---|
| issue CLOSED(无论其他) | 无(展示"已关闭") |
| PR merged | 无(展示"✅ 已交付") |

例外：PR 已 merged 但已确认的清理链尚未完成时，保留「重试清理」；workflow 归档完成后才进入上表的无动作终态。

### P1 任务在跑(进程活着)

| 状态事实 | 按钮 |
|---|---|
| dev/review 任务在跑 | 无动作(显示进度)+「停止」 |

### P2 结构坏(有痕迹,但形态不对)

| 状态事实 | 按钮 |
|---|---|
| 有分支(有内容)+ 无 worktree | 「恢复 worktree 继续开发」 |
| 有分支(空)+ 无 worktree | 「开始开发」(复用/重建) |
| worktree 在,但 detached / 错分支 | 「修复 worktree」 |
| worktree 落后冻结的远端基线 | 「同步 worktree」——优先于一切阶段动作 |

### P3 开发生命周期(结构正常)

| # | 状态事实 | 按钮 |
|---|---|---|
| 1 | 无 worktree + 无分支 + 无 PR(未开发) | 「开始开发」(Codex/Claude + 安全演练) |
| 2 | worktree+分支就位,无内容更新 | 「开始开发」(继续) |
| 3 | 有未提交改动,无任务 | 「恢复开发」;无会话 id → 降级「重新开发」 |
| 4 | 有提交,无 PR | 「创建 PR」(开发完成,推送建 PR 后 Review) |
| 5 | PR open,无 review 结论 | 「Review」 |
| 6 | review 未通过 | 「按意见返工」 |
| 7 | review 通过 + HEAD == 结论哈希 + 验收契约 current | 「合并 PR」 |
| 8 | review 通过 + HEAD ≠ 结论哈希 | 「重新 Review」(结论过期) |
| 9 | review 通过 + 验收契约 changed | 「重新 Review」(验收已变更) |
| 10 | review 通过 + 当前验收契约读取失败(unknown) | 无合并动作,显示「刷新验收状态」 |
| 11 | 仅有 GitHub approval、无 ClickVibe review 契约快照 | 「重新 Review」以建立可审计快照 |
| 12 | PR closed 未合并 | 「查看原因 / 重新开发」(异常,需人) |

### 软事实降级链(贯穿)

- **会话 id 缺失** → resume 降级为「重新开发」(新会话)
- **会话 id 归属缺失或与当前 agent 不一致** → 清除 id + owner,不得跨 Codex/Claude resume,直接在原 worktree 启动全新会话
- **精确会话 id 被 agent 快速拒绝** → 清除 stale id,在同一 task/worktree 内仅回退一次全新会话;已完成 session 初始化或长时间运行后的普通失败不得触发回退
- **review 未通过但问题列表为空** → 视为结论解析异常,清空当前 verdict 并要求重新 Review,不得进入空意见返工
- **review 验证证据** → 命令实际执行后失败标记为「[验证不通过]」;因权限、环境或外部依赖无法执行标记为「[无法验证]」,问题列表原样展示,不得把后者伪装成前者
- **验收契约状态** → `current` 才允许沿用 verdict；`changed` 明确要求重新 Review；`unknown/current-contract-unavailable` 暂停合并并要求刷新，不得谎称「验收已变更」
- **review 结论缺失** → ①本地事件缓存 → ②comment meta → ③GitHub 原生 review(`reviews` 字段)→ ④「人工确认」；GitHub approval 可恢复 verdict，但不含 Issue body 快照，必须标记 `unknown/missing-review-snapshot` 并重新 Review，不自动解锁合并
- **结论缺契约指纹**(历史旧结论) → 标记 `unknown/missing-review-snapshot`，按 #11 重新 Review；它会阻断合并，但不得伪装成已证实的契约变更
- **comment meta 缺失** → 只影响时间线展示,不影响判断

## 四、与现状的差异(落地清单)

1. **去掉 workflow 门槛**:状态推导入口从"已持久化 workflow"改为"GitHub 枚举的每个 open issue"。对无 workflow 的 issue,用约定算候选 worktree/分支,直接查 git 填事实(worktree 无 → head=null;分支无 → 无内容;PR 用 `gh pr list --head <branch>` 查)。`deriveNextAction` 纯函数已支持 idle 分支,缺的只是入口。**回归示例**:本次 "#5 后从未开发过的 issue 不显示开发按钮" 就是 workflow 门槛的症状。
2. **PR / Issue 实时状态与合并执行**:`/state` 实时读取 GitHub PR / Issue 状态；「合并 PR」经单次特权授权后执行 `gh pr merge --merge --match-head-commit <HEAD>`，确认 MERGED 后进入可重入清理链并归档 workflow。清理未完成的 closed Issue 仍保留在活跃列表，避免失去重试入口。
3. **comment 流水带 meta**(关联 #4):开发完成 / review 完成 / 合并都要发评论,meta 至少含:事件类型、绑定的 HEAD、结论(passed + 问题列表)、issue 号。写入是尽力而为,失败时本地事件照记,状态不倒退。
4. **结论绑定契约指纹**:review 结论的 meta 增加 issue 契约指纹(目标/验收正文 hash);保存结论与合并前都校验。issue 正文目标/验收被改 → 旧结论自动过期,按钮回到「重新 Review」,与 HEAD 过期走同一条路径。
5. **自动写动作回读验证**:建 PR / 发评论 / 更新 issue 状态后,立即用 `gh pr view` / `gh api` 回读确认落盘;回读失败只记录,不得把写动作当成功(原则同"写死状态实时查")。

## 五、关联

- 本模型是 **#7(项目优先界面)** 的展示规范:每个 issue 一行 = 状态徽章(阶段)+ 唯一动作按钮(本表)
- **#9(自动选取)** 的 ready 判定 = P3 #1/#2 状态 + blockedBy 依赖全完成
- **#4(PR 评论流水)** 提供 meta,让 GitHub 成为可重建账本
- **#11(跨机器)** 后,"本地 git"事实源路由到执行机,事实类型与判断不变

## 六、P2 恢复动作明细(点「开始开发」后自动执行)

`ensureWorktree` 对 worktree/分支 4 种组合自动处理,无需人工:

| 组合 | 决策 | 动作 |
|---|---|---|
| 分支无 + worktree 无 | add-new-branch | `git worktree add <路径> -b <分支> origin/HEAD`(从远端默认分支建) |
| 分支有 + worktree 有 | reuse | 直接复用 |
| 分支有 + worktree 无 | add-existing-branch | `git worktree add <路径> <分支>` |
| 分支无 + worktree 有(detached) | attach-detached | `git switch -c <分支>` |

半状态兜底:

| 场景 | 决策 | 动作 |
|---|---|---|
| detached 但分支已存在 | attach-existing | `git switch <分支>` |
| git 注册存在但路径缺失/为空(stale) | repair | 清理注册后重建 |
| 分支被其他 worktree 占用 | conflict | 拒绝(不覆盖) |
| 路径是非空未注册目录 | conflict | 拒绝(不覆盖) |

安全边界:冲突一律拒绝,绝不覆盖现有内容;新分支只从 fetch 后的 origin/HEAD 创建,不继承主仓库碰巧停留的 HEAD。

## 七、状态视图展示规范

### 原则

1. **基础事实常驻,派生信号按需**——客观存在的信息常显;对比算出来的信息"有情况才显示,没情况不显示"。
2. **worktree 对比对象只有一个:冻结基线对应的 origin/<branch>(远端)**。默认选择 origin/HEAD，解析后行为与原 origin/main 路径一致;worktree 推导不使用本地 main，本地 main 只出现在下述独立的主仓库本体信号中。
3. **数字必须带语义**,不能裸数字:"落后 2"要能读成"主干有 2 个新提交我还没有"。

### 基础事实(常驻 3 项)

```
📁 worktree    ~/.clickvibe/worktrees/clickvibe/clickvibe-issue-7   (工位在哪)
🌿 分支        clickvibe-issue-7 @ 9f3a2c1                          (在哪干活,HEAD 是什么)
📍 基线        origin/main @ 8715172                                (从哪出发,定格不变)
```

- 基线 = 首次开发选择的 fetch 后 `origin/*` 分支(默认 `origin/HEAD`，兼容回退 `origin/main`)+ 最近一次成功同步持久化的 tip；分支身份定格不变，显式同步时只推进 tip
- 基线的**分支身份永远不变**；`@ tip` 只在显式同步成功 fetch 后前进

### 派生信号(按需出现)

| 状态 | 显示 | 语义 | 按钮 |
|---|---|---|---|
| 落后 0 · 领先 0 | 无 | 干净,无需关注 | 无 |
| 落后 N > 0 | ⚠ 落后 origin/&lt;base&gt; N | 所选基线分支新增 N 个提交,还没并入 | 「同步 worktree」 |
| 领先 M > 0 | 领先 M | 比主干多 M 个提交(开发成果/待 review 量) | 无(状态徽章已表达"有内容") |
| 领先 M · 落后 N(分叉) | 领先 M · 落后 N | 分支与主干分叉,同步将 merge 主干进来 | 「同步 worktree」 |
| 契约已变 | 📋 issue 契约已改 | issue 正文目标/验收与结论绑定指纹不符,结论过期 | 「重新 Review」 |

### 主仓库本体信号(列表头部)

主仓库每次沿用既有 TTL fetch 后的 refs 派生独立横幅,不新增轮询,也不改变上述 worktree 判断:

```
远端 origin/main 领先本地 main 4 · 上次 fetch 2026/8/23 15:30
当前分支 feature/x 落后 origin/main 2
```

- 默认分支取 `origin/HEAD`,不可读时回退 `origin/main`;无可比 ref 或落后数为 0 时隐藏对应行。
- checkout 等于默认分支时隐藏第二行;非默认分支落后时提供「安全同步」。
- 安全同步对纯落后 checkout 做 ff-only,对分叉 checkout 做真实 merge;工作区脏或 detached HEAD 拒绝 checkout 目标。冲突现场保留,不自动 stash/rebase/push。
- 未被 checkout 的本地 main 纯落后时只移动 ref 到远端默认分支;checkout 与 main 两个目标独立判定、独立报告。

配套出现项:

```
🔄 origin/clickvibe-issue-7 @ …   ← 分支推到远端才显示(push 前后对比)
🔗 PR #N                          ← 建了 PR 才显示
```

### 任务进行中形态(developing / reviewing)

```
🚀 开发流程 [开发中]
📁 worktree    ~/.clickvibe/worktrees/clickvibe/clickvibe-issue-7
🌿 分支        clickvibe-issue-7 @ 9f3a2c1
📍 基线        origin/main @ 8715172

■ 实时输出(agent 实时行,深色等宽,200px 滚动)
   [clickvibe] 开发基线: origin/main @ 8715172
   $ git status ...
   ...

[停止任务]
```

- **「实时输出」** = 当前任务的 agent 实时行 + `[clickvibe]` 系统提示行(启动失败/超时/截断等);类名 `cv-dev-log`
- Codex 与 Claude 分别解析各自的结构化流,再归一为可持久化的展示事件;不能在前端靠文本或 emoji 猜 agent 事件类型
- 运行中显示走秒时长;token usage 仅在 agent 流明确提供时展示,不可得时隐藏
- detach 复用同一事件状态与 SSE 连接:桌面放大浮窗,手机(<768px)全屏;收回不创建第二份日志
- 数据恢复(断线重连、Host 重启、2000 行上限)由 #3 负责,本规范只管展示形态
- 任务结束 → 实时输出区收起,内容沉淀进 📜 历史输出与事件时间线

### 完整详情视图形态

```
🚀 开发流程 [待 review]
📁 worktree    ~/.clickvibe/worktrees/clickvibe/clickvibe-issue-7
🌿 分支        clickvibe-issue-7 @ 9f3a2c1
📍 基线        origin/main @ 8715172
⚠ 落后 origin/main 2   [同步 worktree]      ← 仅落后时
🔗 PR #18                                  ← 仅建了 PR 时
```

### 列表视图(#7 每行一个 issue)

```
clickvibe-issue-7   🚧 开发中   ⚠落后2
```

- 每行 = 状态徽章 + 分支名 + 落后徽章(落后才显示)
- 领先不显示(状态徽章"开发中/待 review"已表达"有内容")
- 点开一行 → 展开上面的详情视图

### 与按钮决策表的关系

- 落后检查在**阶段动作之前**(P2 优先):落后 → 同步按钮,同步完成落后归零、领先保留
- worktree 缺失时视图退化为:基础事实里能算的 + 结构坏提示(「恢复 worktree」)
- 本规范只负责**展示**;判断仍由 `deriveNextAction`(纯函数)负责,展示层不重复推导
