# 主仓库基线同步:远端 main 更新信号 + 安全同步(仓库级)

> 2026-08-23 讨论沉淀。痛点:用户/agent 直接在主仓库 checkout 里开发时,主仓库只 fetch refs、从不 pull,面板也没有"远端 main 领先本地"的任何信号——于是基于旧基线开发(真实案例:docs/issue-60-61-design 分支基于旧 main,缺失领域拆分 6 个提交)。
>
> worktree 流程**不受影响**(判断基准 = origin/* 远端 ref,见 [state-model.md](../state-model.md) §七 规则 2),本设计只补**主仓库本体**。
> 配套 [state-model.md](../state-model.md) §七(展示规范);落地遵守 AGENTS.md §3 契约红线(不新增 API method、既有响应形状不变)。

## 目标与边界

**现状缺口**:

- 面板每次 /state 与 /repo/issues 已对配置仓库执行 `git fetch origin --prune`(`ensureConfiguredRepoFresh`,src/index.ts:377,TTL 30-60s)——远端 refs 是新鲜的,但**主仓库本地 main ref 与当前 checkout 工作区从不更新**,也没有"领先本地 N 个提交"的信号。
- worktree 落后已有完整链路:落后徽章 + 「同步 worktree」(`deriveNextAction` src/state-view.ts:177-199,P2 优先)+ `syncWorktree`(src/index.ts:3516)。本地 main 落后被设计为不影响判断(state-model §七)。**worktree 一侧无缺口。**
- **缺口只在主仓库本体**:无信号、无同步入口、agent 介入无固定指引。

**目标**:仓库级信号(远端默认分支领先本地 main N / 当前 checkout 分支落后 M)+ 一个「安全同步」动作:纯落后 ff-only 快进、分叉真实 merge(冲突现场保留并交还 agent)、工作区脏硬拒;agent 介入靠固定附加说明(AGENTS.md 主仓库守则),面板不做自动派发。

**边界**(对齐现有硬原则):

1. **不新增 API method**:扩展现有 `/clickvibe/api/sync` 输入({repoKey} 与现有 {url} 并存);url 路径响应形状零变化(红线 4)。
2. **不新增轮询**:信号基于 fetch 后 refs 派生;fetch 沿用现有 TTL 门。
3. **唯一硬拒绝 = 工作区脏**(绝不覆盖未提交改动);detached HEAD 拒;分叉**不拒**,真 merge(对接用户确认)。
4. **不做**:自动 stash、自动 rebase、push 主仓库 checkout 分支、新增"agent 进主仓库"能力、改动 worktree 流程判断。
5. 冲突现场保留语义对齐 `syncWorktree`(issue #26):MERGE_HEAD + 冲突标记原样留场,不回滚。

## 第 1 节 信号(仓库横幅,列表头部)

位置:列表头部 freshness 横幅区(src/client/index.tsx:2092 的 .cv-stale 一族附近),一个仓库一条:

```
远端 origin/main 领先本地 main 8 · 上次 fetch 于 14:32
当前分支 docs/issue-60-61-design 落后 origin/main 6   ← 仅 checkout ≠ 默认分支且落后>0 时显示
```

- 对比对象 = 仓库默认分支:origin/HEAD(symbolic-ref)→ 兜底 origin/main(复用 `workflowBaseBranch` 语义,state-view.ts:29)。
- N/M=0 或无可比 ref → 不显示该行;fetch 失败/慢沿用现有 .cv-stale 横幅语义(状态可能过期提示)。
- 同步动作成功后客户端刷新横幅,落后归零。

## 第 2 节 动作:安全同步(扩展 /clickvibe/api/sync)

**输入**:payload { repoKey };现有 { url }(worktree 路径)完全不变。

**执行序列**(仓库根;工作区检查对齐 syncWorktree 同款 porcelain 检查):

1. `git fetch origin --prune`
2. 当前 checkout 分支判定:
   - detached HEAD → 拒("不在任何分支上,无法安全同步")
   - 工作区脏(`git status --porcelain` 非空)→ **硬拒**(唯一一律拒绝;提示先提交/清理,绝不 stash、绝不丢弃)
   - 纯落后(ahead=0 且 behind>0)→ `git merge --ff-only origin/<默认>`(快进分支 + 工作区;git 自身保证不覆盖未提交改动)
   - 分叉(ahead>0 且 behind>0)→ `git merge --no-edit origin/<默认>`:
     - 干净 → 产生 merge commit,返回新 HEAD
     - 冲突 → MERGE_HEAD + 标记留场,返回冲突文件清单 + 指引文案:"现场已保留;请在主仓库 workspace 让 agent 处理(附加说明:先同步最新代码并解决冲突),或手动解决后继续"
3. 本地 main ref:纯落后且未被 checkout → `git branch -f main origin/main`(仅 ref 移动,reflog 可回退,不碰任何已检出内容)
4. **逐项独立判定、独立报告**:一项失败不阻塞另一项。

**agent 介入(机制 b)**:面板不自动派发 agent。落地为固定守则:AGENTS.md 主仓库开发守则新增"直接在主仓库工作的 agent,先 `git fetch origin --prune` 并检查遗留冲突(MERGE_HEAD)/本地 main 落后,先同步最新代码再开始任务";同步按钮的拒绝/冲突指引文案同步带上这条附加说明。

**响应形状**(对现有 url 路径响应形状零变化):

```ts
{ ok: true
  branchHead: { branch: string; head: string | null } | null  // 分支快进/merge 后
  mainRefForwarded: boolean
  conflict?: { files: string[] } | null
  refused?: string[] }
| { ok: false, error: string }
```

## 第 3 节 数据与测试

- **纯函数**(repo-freshness.ts 或新文件):输入 origin/<默认>、本地 main、checkout 分支(名/HEAD)、porcelain → 信号两组数字 + 各目标(分支快进 / merge / main ref 快进)的判定;不依赖 shell,单测直测。
- **I/O 收口** index.ts:runCommand / readRevCount / readRefShort(既有)。
- **routes.test.ts fake-shell 模式**(拦截 `git fetch/rev-list/status/merge/branch`)覆盖:信号数据、ff 成功、脏树拒绝、detached 拒绝、分叉 clean merge、分叉冲突留场 + 文件清单、main ref 快进、url 路径回归零变化;不引入 mock 库(AGENTS.md §2.3)。
- **配套文档**:state-model §七 补"主仓库本体信号"(worktree 判断逻辑不变)。
- **门禁**:typecheck / build / test(覆盖率 ≥85%)/ lint / check:size 全绿(AGENTS.md §5)。

## 与 state-model 的关系

- §七 规则 2"对比对象只有一个 origin/main,不显示本地 main"——**worktree 判断不变**;本设计新增的是仓库级横幅(本地 main 落后是它的信号对象),两条线互不干扰。
- 本地 main 落后在本设计中第一次**可被看见、可被清零**,但从不参与 worktree 推导。
