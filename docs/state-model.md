# ClickVibe 状态模型:事实分级与按钮决策表

> 2026-08-22 讨论沉淀。回答一个问题:**"这个 issue 现在处于什么状态,下一步该做什么、显示什么按钮"** —— 判断必须只依赖客观、保证存在的事实,任何"可能缺失"的东西都只能当增强器,不能当门槛。

## 一、核心原则

1. **git + GitHub 原生事实 = 判断的地基**。它们客观存在,不依赖任何人"记得写"。
2. **workflow 文件 ≠ 门槛**。它是缓存(worktree 路径其实可推导、会话 id、事件历史),缺失时判断必须照常工作,最多结论更保守。
3. **comment meta = 增强器**。允许缺失;缺失时走降级链(GitHub 原生 review → 人工确认),**永不因缺 meta 而卡死,也永不因缺判据而瞎猜**。
4. **入口从 GitHub issue 出发**:枚举 repo 的 open issue,用约定(config 的 repo 路径 + worktreeRoot + issue 号)算出候选 worktree/分支,再用 git 查真相;workflow 文件存在时只叠加缓存信息。

## 二、事实分级

| 级别 | 事实 | 来源 | 获取手段 |
|---|---|---|---|
| **硬** | issue OPEN/CLOSED | GitHub | `gh issue view` |
| **硬** | worktree 有无、registered branch | 本地 git | `git worktree list --porcelain` 交叉约定路径 |
| **硬** | 目标分支有无(本地/远端) | 本地 git | `git show-ref` / `for-each-ref` |
| **硬** | 内容更新(不管是否 commit) | 本地 git | `git status --porcelain` + `git log <fork点>..HEAD` |
| **硬** | fork 点(baseline 曾经是什么) | 本地 git | `git merge-base origin/main <branch>` |
| **硬** | 应同步基线(现在该是什么) | 本地 git | `origin/HEAD` / `origin/main` 当前 tip |
| **硬** | PR 存在 / open / merged / closed | GitHub | `gh pr list --head <branch>` + `gh pr view` |
| **硬** | GitHub 原生 review(APPROVED/CHANGES_REQUESTED/COMMENTED) | GitHub | `gh pr view --json reviews`(受控词表,字段保证存在) |
| **软** | review 结论(通过 + 问题列表) | 本地事件 / comment meta | 见降级链 |
| **软** | 结论绑定的 HEAD | 本地事件 / comment meta | 同上 |
| **软** | 会话 id(续会话用) | 本地(进程/文件) | 缺失 → resume 降级为重新开发 |
| **软** | 任务是否在跑 | 进程本地 | 唯一非 git/GitHub 事实,天然临时;可推导出"中断"结论 |
| **软** | comment meta(事件流水) | GitHub 评论 | 只影响时间线展示,不影响判断 |

## 三、按钮决策表(按优先级)

### P0 终端状态(一票否决)

| 状态事实 | 按钮 |
|---|---|
| issue CLOSED(无论其他) | 无(展示"已关闭") |
| PR merged | 无(展示"✅ 已交付") |

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
| worktree 落后 origin/main | 「同步 worktree」——优先于一切阶段动作 |

### P3 开发生命周期(结构正常)

| # | 状态事实 | 按钮 |
|---|---|---|
| 1 | 无 worktree + 无分支 + 无 PR(未开发) | 「开始开发」(Codex/Claude + 安全演练) |
| 2 | worktree+分支就位,无内容更新 | 「开始开发」(继续) |
| 3 | 有未提交改动,无任务 | 「恢复开发」;无会话 id → 降级「重新开发」 |
| 4 | 有提交,无 PR | 「创建 PR」(开发完成,推送建 PR 后 Review) |
| 5 | PR open,无 review 结论 | 「Review」 |
| 6 | review 未通过 | 「按意见返工」 |
| 7 | review 通过 + HEAD == 结论哈希 | 「合并 PR」 |
| 8 | review 通过 + HEAD ≠ 结论哈希 | 「重新 Review」(结论过期) |
| 9 | PR closed 未合并 | 「查看原因 / 重新开发」(异常,需人) |

### 软事实降级链(贯穿)

- **会话 id 缺失** → resume 降级为「重新开发」(新会话)
- **review 结论缺失** → ①本地事件缓存 → ②comment meta → ③GitHub 原生 review(`reviews` 字段)→ ④「人工确认」(不自动合并、不自动返工)
- **comment meta 缺失** → 只影响时间线展示,不影响判断

## 四、与现状的差异(落地清单)

1. **去掉 workflow 门槛**:状态推导入口从"已持久化 workflow"改为"GitHub 枚举的每个 open issue"。对无 workflow 的 issue,用约定算候选 worktree/分支,直接查 git 填事实(worktree 无 → head=null;分支无 → 无内容;PR 用 `gh pr list --head <branch>` 查)。`deriveNextAction` 纯函数已支持 idle 分支,缺的只是入口。**回归示例**:本次 "#5 后从未开发过的 issue 不显示开发按钮" 就是 workflow 门槛的症状。
2. **补 PR 状态查询**:当前 `/state` 里 `prMerged` 写死 `false`(注释:需要网络查询,/state 不做网络 IO)。合并状态应实时查 GitHub(或按需 + 短缓存),否则已合并的 PR 还显示"合并 PR"按钮。
3. **comment 流水带 meta**(关联 #4):开发完成 / review 完成 / 合并都要发评论,meta 至少含:事件类型、绑定的 HEAD、结论(passed + 问题列表)、issue 号。写入是尽力而为,失败时本地事件照记,状态不倒退。

## 五、关联

- 本模型是 **#7(项目优先界面)** 的展示规范:每个 issue 一行 = 状态徽章(阶段)+ 唯一动作按钮(本表)
- **#9(自动选取)** 的 ready 判定 = P3 #1/#2 状态 + blockedBy 依赖全完成
- **#4(PR 评论流水)** 提供 meta,让 GitHub 成为可重建账本
- **#11(跨机器)** 后,"本地 git"事实源路由到执行机,事实类型与判断不变
