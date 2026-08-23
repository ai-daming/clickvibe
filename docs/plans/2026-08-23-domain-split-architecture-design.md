# ClickVibe 领域拆分架构设计(issue #61)

> 2026-08-23 设计沉淀。目标读者:issue #61 的执行 agent 与后续维护者。
> 本文回答三个问题:**把什么搬到哪、凭什么搬对、怎么证明搬对了**。

## 0. 一页总结

- 现状两条单体:`src/index.ts`(4000 行,宿主侧路由/处理/编排全在一个文件)、`src/client/index.tsx`(2404 行,面板状态/展示/工具全在一个文件)。其余 21 个 src 文件都已 ≤500 行且大多已按领域分置——真正要拆的只有这两个文件。
- 拆分动作**只有"搬移 + 分层"**:不重写业务逻辑、不改对外契约、每个 PR 测试全绿。172 个测试是契约锚点。
- 服务端目标:`src/index.ts` 收敛为**合成根**(路由注册 + 薄 handler 分发表,≤500 行),业务迁入 `workflow / github / agent / infra` 四域,依赖单向。
- 客户端目标:`src/client/index.tsx` 拆成 `api / domain / format / styles / panel-state`(工具与状态)+ `views/*`(展示组件),入口只留激活 bootstrap。
- 门禁先行:先落**行数检查脚本 + biome lint + GitHub Actions CI**,两个单体临时列入例外清单,拆分每个 PR 都在门禁全绿下进行,随拆随撤例外。
- 「纯逻辑与 I/O 分离」沿用 `state-view.ts` 范本:推导/映射/格式化全为纯函数,shell/fs/网络/时间全部留在 `infra/github` 适配层。

## 1. 目标与边界(issue #61 转写)

**目标**:把 src 侧的单体按领域拆成职责分明的模块,落地三条规则并由机器门禁守住:
1. 每文件 ≤500 行(>800 无条件拆);
2. 目录按领域职能组织,同领域闭环、模块间依赖单向;
3. 纯逻辑与 I/O 分离。

**验收标准**(6 条,逐条对应本文节,见 §11 对照表):
- index.ts 仅剩路由注册与方法分发,handler 只做「解析入参 → 调领域函数 → 序列化响应」;
- client/index.tsx 按职责拆分(状态/展示/工具),新文件 ≤500 行;
- src/ 按领域目录组织,依赖单向;
- 500 行规则写入 README 维护者节(>500 须解释、>800 无条件拆、拆分后全库无 >500 例外);
- 172 个测试全绿,对外契约不变(路由表、响应形状、~/.clickvibe/state/ 格式、agent 命令);
- CI 接入 GitHub Actions(install→typecheck→build→test);lint/format 接入并提供 lint 脚本,CI 同步执行。

**约束**(照搬不越界):不引入 UI 组件库/Tailwind/CSS Modules/状态库/router;zod 等运行时校验库仅在拆分后仍有 ≥3 处重复校验时引入;拆分与功能开发分开;不删除、不重写既有业务逻辑,只搬移与分层。

## 2. 现状盘点(事实)

### 2.1 文件与行数(2026-08-23)

| 文件 | 行数 | 职责 | 判定 |
|---|---|---|---|
| src/index.ts | 4000 | 宿主侧全部:路由、HTTP、git、github 读取、workflow 推导、合并门禁、agent 进程监督、提示词 | **拆分主体** |
| src/client/index.tsx | 2404 | 面板全部:状态、API 调用、markdown/TUI 渲染、各领域视图、激活 bootstrap | **拆分主体** |
| src/develop.ts | 469 | agent 命令构建 / 授权 / worktree 恢复决策 | ≤500,迁入 agent/ |
| src/command.ts | 345 | 文本命令解析 / 预览 / 格式化 | ≤500,迁入 infra/ 或保留根 |
| src/state.ts | 360 | ~/.clickvibe/state/ 持久化 I/O | ≤500,迁入 infra/ |
| src/state-view.ts | 289 | 下一步动作纯推导(state-view **范本**) | ≤500,workflow 纯逻辑层 |
| src/github-rest.ts | 302 | gh api REST 客户端 / 限流 / 错误 | ≤500,迁入 github/ |
| src/review-result.ts | 165 | review 结论文件读写/校验 | ≤500 |
| src/prompt.ts | 130 | 提示词构建 | ≤500,迁入 agent/ |
| 其余 14 个 src 文件 | ≤217 | live-output / agent-stream(217) / delivery-* / review-approval / auto-development / issue-contract / repo-freshness / task-gate / task-history / invariant / 客户端 3 个 | ≤500,就地归位 |

**结论:除两个单体外,仓库已是"按领域分文件"的形态;缺的是目录组织、依赖方向约束、行数门禁和 CI/lint。**

### 2.2 src/index.ts 功能簇(4000 行)

| # | 行区间 | 内容(代表函数) | 目标域 |
|---|---|---|---|
| 1 | 1–177 | 头注释路由清单、module augmentation(Context.webServer/shell 类型) | 保留在合成根 |
| 2 | 178–258 | ClickVibeConfig、LiveTask、loadConfig、expandHome、taskId、notifyTask | infra/config |
| 3 | 259–371 | parseUrl、privilegedRequestError、authorizationInputFromPayload、consumeAuthorization、readJsonBody、writeJson、githubAwareStatus、runCommand | infra/http + infra/shell |
| 4 | 372–428 | fetchTtlMs、ensureConfiguredRepoFresh、readWorktreeHead、detectLinkedPr | infra/config、infra/git、github/pr |
| 5 | 429–616 | REST 读取与映射:fetchPrRestDetail/fetchPrRestReviews/fetchIssueRestDetail、mapComments/mapIssueDetail/mapPrDetail 及 REST 类型 | github/reads(+github/rest) |
| 6 | 617–902 | git 原语:readRefShort/readBranch/readRevCount/hasMergeConflict/listConflictFiles、buildMergePreface、**deriveWorkflowState** | infra/git + workflow/derive |
| 7 | 903–970 | **export const name/inject、apply**(路由注册) | 保留在合成根 |
| 8 | 971–1181 | **handleApiPost(17 method 分发表)**、stateWorkflows、resolveCommandRepoKey/Target、formatWriteOutcome | 合成根(分发表)+ workflow/handlers |
| 9 | 1182–1453 | **handleCommand**、resolveResumeAgent、listProjects | workflow/handlers(use case) |
| 10 | 1454–1611 | **enrichWorkflowStates**、Repository* 类型、firstDevelopmentFor、maintainCompletedDependencyLedger、fetchGithubRepoSnapshot | github/facts |
| 11 | 1612–1892 | **fetchRepositoryIssues**(export)、fetchIssue、issueSnapshot | github/reads |
| 12 | 1893–2056 | fetchIssueContract、latestPassingReview(Hash)、sameCommitHash、MergeGateFailure、**isSyncEquivalentMerge**、**assertReviewHeadMatchesPr**、collectMergeGateFailures、mergeGateRejection | workflow/merge-gates |
| 13 | 2057–2202 | mergeAuthorizationPreview、authorizeAgent、MergeResult、**mergeAndCleanup(Unlocked)** | workflow/merge |
| 14 | 2417–2510 | IssueDependency、fetchDependencies、fetchTimeline | github/dependencies |
| 15 | 2511–2712 | ResolvedPromptSnapshot、resolvePromptSnapshot、sameSnapshot、buildDevelop/Review/ResumePrompt、fetchPrPromptComments、fetchPrBase、fetchPrHeadBranch | agent/prompts + github/pr |
| 16 | 2713–2900 | ensureWorktree、parseWorktreeList | agent/worktree |
| 17 | 2901–3100 | LiveTask 生命周期:createLiveTask/pushTaskLine/scheduleTaskCleanup/finishTask/attachAgentProcess | infra/task-supervisor |
| 18 | 3101–3514 | resolveAutomaticFirstDevelopment、**startDevelop**、pollDevelop、resolveHistoryTarget、getTaskHistory、**handleStream(SSE)**、stopTask、**syncWorktree**(export) | workflow/develop-flow + infra/http(stream/history) |
| 19 | 3607–3886 | **startReview**、recordDevDelivery、publishDeliveryComment | workflow/review-flow + workflow/delivery |
| 20 | 3887–4000 | **resumeDevelop**(export) | workflow/develop-flow |

### 2.3 src/client/index.tsx 分节(2404 行)

| # | 行区间 | 内容 | 目标 |
|---|---|---|---|
| 1 | 1–62 | import、slot 类型、panelState + usePanelOpen | client/panel-state |
| 2 | 285–434 | PANEL_CSS + installStyles、renderInline/renderMarkdown | client/styles + client/format |
| 3 | 435–550 | fmtDate、GhComment/GhIssue/TimelineEvent 类型、PrStateIcon/IssueStateIcon、repoOf、linkedState(Label) | client/format + client/domain |
| 4 | 551–748 | DshOpenButton、**IssueView** | client/views/issue-view |
| 5 | 749–875 | **apiCall**、Workflow/NextAction/WorkflowEvent/MergeGateFailure 类型、fmtTime、stageLabel | client/api + client/domain + client/format |
| 6 | 876–958 | **LiveTerminal** | client/views/live-terminal |
| 7 | 959–1693 | **DevSection(≈735 行,超限)** | client/views/dev-section + 再拆(review-status / actions / history) |
| 8 | 1694–1762 | CommentsSection、fetchIssue、ProjectOption/RepositoryIssue/RepositoryFreshness/WorkflowStateResponse 类型 | client/views/comments + client/api + client/domain |
| 9 | 1763–2230 | **PanelContent(≈468 行,接近上限)** | client/views/project-panel |
| 10 | 2231–2367 | OccupiedPanel + detach 浮窗 | client/views/occupied-panel |
| 11 | 2368–2404 | **export const name/inject、apply(激活)** | 保留 client/index.tsx |

### 2.4 契约面(测试引用,拆分不能断)

- 测试直接 `import … from '../src/index.ts'`:routes.test.ts(apply、fetchRepositoryIssues)、command.test.ts(apply)、state-view-integration.test.ts(deriveWorkflowState、enrichWorkflowStates)、sync-conflict.test.ts(buildMergePreface、deriveWorkflowState、resumeDevelop、syncWorktree)、sync-equivalence.test.ts(assertReviewHeadMatchesPr、isSyncEquivalentMerge)。
- 路由表 17 个 method:`fetch / projects / repo/issues / state / authorize / develop / develop/poll / history / stream / review / resume / stop / sync / merge / command`(+stream GET、history GET 特例)。
- 构建入口:`tsdown.config.ts` 固定 `src/index.ts`、`src/invariant.ts`、`src/client/index.tsx` 三个 entry,搬移不得移动这三个文件本身。
- 测试基础设施:routes/command/review 等测试注入 **mock shell**(拦截 `gh api`),worktree-integration 用**真实 git**(child_process);CI 需要 git + git identity,gh 走 mock 不需要真调用。

## 3. 三条规则的落点

### 3.1 每文件 ≤500 行(>800 无条件拆)

- 阈值以**物理行数**(含注释/空行)计,脚本统计,不以"逻辑行"计——机器可判、无争议。
- (500, 800] 区间允许,但必须**可解释**:文件内第一行注释写明理由,或登记在 `scripts/file-size-exceptions.json` 清单;>800 一律拒绝。
- 例外清单随拆分逐个清零;终点状态:全库(src + tests)无 >500 行文件,清单为空或仅含 ≤3 条已解释例外。
- 落地:仓库根 `scripts/check-file-size.mjs`,package.json 增 `check:size` 脚本,CI 同步执行(见 §7)。

### 3.2 目录按领域组织,模块依赖单向

四域定义(自底向上,层号即依赖上限):

| 层 | 目录 | 职责 | 反面教材(禁止) |
|---|---|---|---|
| 0 | `src/infra/` | 适配器:I/O、HTTP 传输、shell/git、进程监督、持久化、流编解码、TTL 门 | 不得 import github/agent/workflow |
| 1 | `src/github/` | GitHub 适配:一切 `gh api` 读写、REST 映射、仓库/issue/pr/依赖读取 | 不得 import workflow/agent;可依赖 infra |
| 2 | `src/agent/` | agent 会话:命令构建、授权、提示词、worktree 保障、会话归属 | 不得 import workflow;可依赖 infra/github |
| 3 | `src/workflow/` | 业务流程(use cases):推导、合并门禁、命令 handler、开发/review/resume 编排 | 可依赖全部下层 |
| 4 | `src/index.ts` | 合成根:类型注入、路由注册、薄 handler 分发表、re-export 锚点 | 只依赖 workflow(及其下层),不写业务逻辑 |

依赖规则(机器可检):**文件只能 import 层号 ≤ 自身的模块;层内跨域 import 需 review(原则上不允许,除 github→infra、agent→github/infra、workflow→一切)。** `client/**` 自成一体,不得 import `src/**`。

### 3.3 纯逻辑与 I/O 分离(state-view.ts 范本)

- **范本**:`src/state-view.ts` —— 输入普通数据(WorkflowFacts),输出普通数据(NextAction),无 shell/fs/网络/时间,整表可直接单测、无沙箱依赖。**拆出的每个新模块都要能回答:「这个函数碰 I/O 吗?碰,进适配层;不碰,进纯逻辑层,并配纯逻辑测试」**。
- 判定标准:函数引用下列任一符号即视为 I/O 函数:`ctx.shell`、`fs`、`http`、`child_process`、`Date.now`、`randomBytes`、进程句柄、外部包(如 yaml 解析视为边界但允许在适配层);否则为纯函数。
- 落地形式:同一功能簇拆成「纯推导」(放 workflow/ 或 agent/ 内的纯逻辑文件,参照 state-view.ts 风格,顶部写职责注释)+「I/O 适配」(放 infra/github/)。典型:deriveWorkflowState 的推导部分与 state 读取分离、startDevelop 的"决策下一步"与"shell 执行"分离。
- 原则正文(写入 docs/architecture.md 的草案,§10 也收录,落地 PR 原样搬入)。

## 4. 服务端目标结构

```
src/
├── index.ts                  # 合成根:apply + handleApiPost 分发表 + re-export 锚点(≤500)
├── invariant.ts              # 保持(纯工具,构建入口之一)
├── infra/                    # 层 0 — 适配器
│   ├── config.ts             # ClickVibeConfig / loadConfig / expandHome / fetchTtlMs / ensureConfiguredRepoFresh
│   ├── http.ts               # readJsonBody / writeJson / githubAwareStatus / privilegedRequestError /
│   │                         #   authorizationInputFromPayload / consumeAuthorization / handleStream / getTaskHistory
│   ├── git.ts                # runCommand / readRefShort / readBranch / readRevCount / hasMergeConflict /
│   │                         #   listConflictFiles / conflictFileSuffix / parseWorktreeList / syncWorktree / buildMergePreface
│   ├── task-supervisor.ts    # LiveTask / liveTasks / createLiveTask / pushTaskLine / scheduleTaskCleanup /
│   │                         #   finishTask / attachAgentProcess / stopTask / pollDevelop 的进程与日志缓冲部
│   ├── state.ts              # ← 现有 state.ts 迁入(持久化)
│   ├── live-output.ts        # ← 现有(流编码)
│   ├── repo-freshness.ts     # ← 现有(TTL 门)
│   ├── task-gate.ts          # ← 现有(互斥门)
│   └── task-history.ts       # ← 现有(历史解析)
├── github/                   # 层 1 — GitHub 适配
│   ├── rest.ts               # ← 现有 github-rest.ts 迁入(githubRest / deriveReviewDecision / 限流 / 错误)
│   ├── reads.ts              # fetchPrRestDetail / fetchPrRestReviews / fetchIssueRestDetail / mapComments /
│   │                         #   mapIssueDetail / mapPrDetail / fetchIssue / issueSnapshot
│   ├── facts.ts              # fetchGithubPrFact / fetchGithubIssueState / readConfiguredBranchFacts /
│   │                         #   fetchGithubRepoSnapshot / enrichWorkflowStates / fetchRepositoryIssues / maintainCompletedDependencyLedger
│   ├── pr.ts                 # fetchPrBase / fetchPrHeadBranch / fetchPrPromptComments / detectLinkedPr
│   └── dependencies.ts       # IssueDependency / fetchDependencies / fetchTimeline
├── agent/                    # 层 2 — agent 会话
│   ├── develop.ts            # ← 现有迁入(buildDevelopAgentCommand 等 / AuthorizationStore / worktree 恢复决策)
│   ├── prompts.ts            # ResolvedPromptSnapshot / resolvePromptSnapshot / sameSnapshot / buildDevelopPrompt /
│   │                         #   buildReviewPrompt / buildResumePrompt(读取经 github/pr)
│   ├── worktree.ts           # ensureWorktree / parseWorktreeList 用法 / resolveAutomaticFirstDevelopment 的 worktree 决策
│   └── session.ts            # resolveResumeAgent(会话归属)
└── workflow/                 # 层 3 — 业务流程(use cases)
    ├── derive.ts             # deriveWorkflowState / latestPassingReview(Hash) / sameCommitHash(复用 state-view.ts 纯推导)
    ├── handlers.ts           # handleCommand / resolveCommandRepoKey / resolveCommandTarget / formatWriteOutcome / listProjects / stateWorkflows
    ├── develop-flow.ts       # startDevelop / pollDevelop 编排 / resumeDevelop / resolveAutomaticFirstDevelopment / stopTask 调度 / recordDevDelivery / publishDeliveryComment
    ├── review-flow.ts        # startReview / approvePassedReview 联动 / latestPassingReview 使用
    ├── merge.ts              # authorizeAgent / mergeAuthorizationPreview / mergeAndCleanup(Unlocked)
    ├── merge-gates.ts        # MergeGateFailure / collectMergeGateFailures / mergeGateRejection / isSyncEquivalentMerge / assertReviewHeadMatchesPr
    └── (迁入现状小模块:auto-development.ts / issue-contract.ts / review-*.ts / delivery-*.ts / state-view.ts / prompt.ts / command.ts 按域归位)
```

搬移原则:

1. **搬移单位是函数/函数簇,不拆单个函数**:一个函数整体迁移,不允许把一个函数劈成两半跨文件(避免拆出半吊子、跑挂中间态);巨型函数若 >500 行文件仍超限,先从"同文件内提纯函数"入手。
2. **re-export 锚点保住契约**:§2.4 列出的被测试直接引用的导出(apply、fetchRepositoryIssues、deriveWorkflowState、enrichWorkflowStates、buildMergePreface、resumeDevelop、syncWorktree、assertReviewHeadMatchesPr、isSyncEquivalentMerge)**继续从 src/index.ts re-export**,测试零改动即可守住契约;新增内部导出在域内就近。
3. 现有小模块(§2.1 判定为 ≤500 的)**整体搬入对应目录**,import 路径在**同一次搬移 PR 内一次性全局改**、typecheck 绿灯后提交,不做"先留根目录再迁"的过渡态。

## 5. 客户端目标结构(状态/展示/工具分离)

```
src/client/
├── index.tsx            # 激活 bootstrap:name / inject / apply(只注册面板与插槽,≤500)
├── domain.ts            # 类型层:GhComment/GhIssue/TimelineEvent/Workflow/WorkflowEvent/NextAction/
│                        #   MergeGateFailure/ProjectOption/RepositoryIssue/RepositoryFreshness/…(全部纯类型)
├── api.ts               # 工具:apiCall / fetchIssue / 各 method 的请求封装(唯一 fetch I/O 出口)
├── format.ts            # 纯展示工具:renderInline / renderMarkdown / fmtDate / fmtTime / repoOf /
│                        #   linkedState(+Label) / stageLabel
├── panel-state.ts       # 面板开合状态:panelState / usePanelOpen / setPanelOpen
├── styles.ts            # PANEL_CSS / installStyles(样式字符串常量 + 注入)
└── views/
    ├── issue-view.tsx       # IssueView + DshOpenButton + IssueStateIcon/PrStateIcon + CommentsSection
    ├── live-terminal.tsx    # LiveTerminal(事件流 TUI)
    ├── dev-section.tsx      # DevSection 主骨架(≈735 → 拆)
    ├── dev-review.tsx       # DevSection 的 review 结论/返工/重审区块
    ├── dev-actions.tsx      # DevSection 的动作按钮区(develop/review/rework/resume/sync 等)
    ├── dev-history.tsx      # DevSection 的历史折叠/恢复区块
    ├── project-panel.tsx    # PanelContent(项目列表/分组/批量下单)
    └── occupied-panel.tsx   # OccupiedPanel + detach 浮窗
```

拆分要点:

- **DevSection(≈735 行)是唯一超限组件**,按"动作区 / review 区块 / 历史区 / 主骨架"再拆,每一块 ≤500(目标各 ≤300)。
- PanelContent(≈468 行)虽未超限,**状态逻辑与 JSX 同文件已违背"状态/展示分离"**——把状态与轮询逻辑提出为 `useProjectPanel` hook(放 panel-state.ts 或 views/project-panel 内),JSX 只消费。
- 渲染侧纯函数(renderMarkdown 等)进 format.ts,与组件解耦后可单测(当前无客户端测试文件,PR-7 顺手补 format/domain 纯函数测试)。
- 客户端入口 export 面(package.json `./client` → src/client/index.tsx apply)不变。

## 6. 对外契约保持不变清单

| 契约面 | 内容 | 守护方式 |
|---|---|---|
| 路由表 | 17 个 method + stream/history 的 GET 特例 + 404/405 语义 | tests/routes.test.ts(不动) |
| 响应形状 | 每个 method 的 `{ok, …}` 结构与错误码(githubAwareStatus) | routes.test.ts |
| 持久化格式 | ~/.clickvibe/state/ 的 workflow JSON、dev.log/review.log、review-result.json | tests/state.test.ts、state-view-integration、sync-* |
| agent 命令 | 两阶段授权协议(预览→一次性 2 分钟授权→执行)、dryrun 回环限制、codex/claude 命令构造 | tests/routes.test.ts、develop.test.ts |
| 文本命令语法 | parseCommand / command-reference.md 全部命令 | tests/command.test.ts |
| 插件契约 | package.json exports(./ 与 ./client)、tsdown 三 entry、`window.__ModuleLoader__` client bundle | 构建本身 |
| 类型面 | lib/types/*.d.ts(tsc declaration 生成) | typecheck + build |

> 一条底线:**拆分 PR 内若测试因 import 路径变更而改,只允许改 import 语句;断言、fixture、行为一律不动。**

## 7. 门禁设计(先建门,再拆楼)

### 7.1 行数检查 `scripts/check-file-size.mjs`

- 扫描 `src/**/*.{ts,tsx}` 与 `tests/**/*.ts`;统计物理行数;
- 规则:≤500 通过;500–800 须在 `scripts/file-size-exceptions.json` 登记(字段:path、lines、reason、issueRef);>800 直接失败;
- 输出表:文件 / 行数 / 状态,退出码非 0 即 CI 红;
- package.json:`"check:size": "node scripts/check-file-size.mjs"`。
- 初始状态:exceptions.json 登记 `src/index.ts`(4000,待 #61 拆分)与 `src/client/index.tsx`(2404,待 #61 拆分);每个拆分 PR 落地后删除自身条目,收尾 PR 验证清单为空。

### 7.2 lint/format:选 **biome**

决策理由(相对 eslint):
- 仓库零 lint 历史,没有规则遗产要兼容——biome 开箱默认即合理;
- 单二进制、无插件/配置链,**符合「不引入重量级依赖、不为上框架而上」的约束精神**;eslint 需 typescript-eslint + flat config + 多包依赖,收益对本规模无差;
- 同时给 formatter 与 linter,顺带 import 排序(organizeImports),与「搬移后 import 面干净」的需求直接对口;
- 支持 TSX / node:test 语法,与现有 tsconfig(jsx: react-jsx、allowImportingTsExtensions)兼容。

落地:
- 根 `biome.json`(extends 默认 recommended,v2 语法:`"linter": { "rules": { "recommended": true } }`、`"formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 }`、`"javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } }`、organizeImports 开;files 含 `**/*.{ts,tsx}`,ignore lib、node_modules、dist);
- package.json:`"lint": "biome check src tests scripts"`、`"lint:fix": "biome check --write src tests scripts"`、`"fmt": "biome format --write src tests scripts"`、`"check": "pnpm typecheck && pnpm lint && pnpm check:size"`;
- CI 执行 `pnpm lint`(只读检查,不做 --write,防止 CI 改写源码)。

### 7.3 CI `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4                    # 读 packageManager 或显式 version
      - uses: actions/setup-node@v4
        with:
          node-version: 24                            # node:test 直跑 .ts 需 ≥22.6;24 LTS 稳妥
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run build
      - run: pnpm test
      - run: pnpm run lint
      - run: pnpm run check:size
      - name: git identity (worktree-integration 需要真实提交)
        run: |
          git config --global user.email "ci@clickvibe.local"
          git config --global user.name "ClickVibe CI"
```

真实环境依赖处理:
- **git**:ubuntu-latest 自带;worktree-integration / sync-conflict 等用真实 git 建仓库,需 git identity(上面 step);
- **gh**:ubuntu-latest 预装 gh;测试注入 mock shell 拦截 `gh api`,**实际不调用 gh**,仅需二进制存在;不配 token、不开网络写操作;
- **node:test 直跑 TS**:需 node ≥22.6(type stripping);测试文件为 .ts,`node --test tests/*.test.ts` 原样执行;
- 时间敏感/网络相关的测试(rate-limit 等)已是 mock 驱动,CI 无外部依赖。

## 8. 拆分执行计划(PR 序列,每步测试全绿)

**每 PR 的完成定义(DoD)**:typecheck + build + test(172)+ lint + check:size 全绿;无行为变更(纯搬移);契约面测试文件零断言改动;PR 描述附"搬了哪些函数、引用面 grep 结果"。

| PR | 内容 | 效果 |
|---|---|---|
| **PR-0 门禁先行** | CI workflow、biome.json + lint 脚本、check-file-size + exceptions.json(登记两个单体)、README 维护者节写入三条规则、docs/architecture.md 落地「纯逻辑与 I/O 分离 + state-view 范本」 | 拆分的"裁判"就位;全库其余文件 lint/行数全绿 |
| **PR-1 infra 层** | index.ts 簇 2/3/4/6 的 infra 部迁出(config/http/git/task-supervisor 的进程与传输部),index.ts 改为 import | index.ts 减 ≈600 行 |
| **PR-2 github 层** | 簇 5/10/11/14 迁出(github/rest/reads/facts/pr/dependencies),enrichWorkflowStates/fetchRepositoryIssues 由 index.ts re-export | index.ts 减 ≈900 行 |
| **PR-3 agent 层** | 簇 15/16 迁出(agent/prompts、agent/worktree、agent/session),develop.ts/prompt.ts 迁入 agent/ | index.ts 减 ≈450 行 |
| **PR-4 workflow 层** | 簇 9/12/13/18/19/20 迁出(handlers/derive/merge/merge-gates/develop-flow/review-flow),重导出锚点齐 | index.ts 减 ≈1900 行 |
| **PR-5 合成根收敛** | index.ts 瘦身为 apply + handleApiPost 分发表 + re-export;exceptions.json 删除 index.ts 条目 | index.ts ≈300–450 行 |
| **PR-6 客户端工具与状态** | client/domain.ts、api.ts、format.ts、styles.ts、panel-state.ts 迁出;顺手补 format/domain 纯函数测试 | index.tsx ≈1500 行 |
| **PR-7 客户端视图** | views/issue-view、live-terminal、dev-review、dev-actions、dev-history、project-panel、occupied-panel;PanelContent 状态提 hook | index.tsx ≈100 行 |
| **PR-8 收尾** | exceptions.json 清零(或仅 ≤3 条解释例外)、README/architecture 文档终稿、全量复核 172 测试与导出面 | #61 全部验收项可勾选 |

顺序依据:**自底向上(infra→github→agent→workflow),每层独立可验证、依赖不回头**;客户端独立于服务端推进(PR-6/7 可与 PR-1..5 并行)。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 搬移引入 import 环(如 workflow↔github) | 分层规则 + `check-import-layers`(可并入 check-file-size 或独立脚本):按 §3.2 层号扫 import,违规即红 |
| 导出面漂移导致测试改断言 | §2.4 契约测试不动 + index.ts re-export 锚点;PR DoD 强制 grep 引用面 |
| 单个巨型函数搬家后文件仍超限 | 拆的单位是"函数簇",先在同文件提纯、再整体迁移;禁止把函数劈两半 |
| 大 PR 难以 review | 每 PR 只动一层、纯搬移,diff 应为"删除+新增同构"、无行为改写;描述附函数清单 |
| 纯逻辑层被注入 I/O(范本被破坏) | §3.3 判定标准写入 architecture.md;review 时按"是否触碰 ctx.shell/fs/网络"检查新文件 |
| 客户端样式字符串/组件搬错导致面板崩溃 | client 由 build + 人工在 DSH 页面验证;每 PR 在真实页面检查展开/详情/终端三类视图 |
| CI 上 node:test 直跑 TS 失败 | setup-node 24 + pnpm frozen-lockfile;若 runner 版本问题,test 脚本显式加 `--experimental-strip-types` 兜底 |

## 10. 「纯逻辑与 I/O 分离」原则正文(落地写入 docs/architecture.md)

> **原则:推导、映射、格式化必须是纯函数;一切 I/O 必须集中在适配层。**
> 1. 纯函数 = 输入输出都是普通数据、不触 shell/fs/网络/时钟/进程句柄;同一输入必得同一输出。
> 2. 范本 = `src/state-view.ts`:状态推导表是纯函数,整表可无沙箱单测;调用它的 gh/git 读取层做 I/O。
> 3. 新文件落位时先回答「这个函数碰 I/O 吗」:碰 → infra/ 或 github/ 适配层;不碰 → workflow/agent 纯逻辑文件,并配纯逻辑测试。
> 4. 例外唯一形态:纯逻辑为了性能/原子性必须内联 I/O 时,函数签名显式接收依赖(依赖注入),测试注入替身。

## 11. 验收对照表(issue #61)

| 验收项 | 对应设计 |
|---|---|
| index.ts 仅路由+分发,handler 三件事 | §4(合成根)+ §8 PR-5 |
| client/index.tsx 按职责拆分,≤500 | §5 + §8 PR-6/7 |
| src/ 按领域目录、依赖单向 | §3.2 + §4 + §7.2 依赖检查 |
| 500 行规则写入 README 维护者节 | §3.1 + PR-0(正文模板见 §3.1/§10) |
| 172 测试全绿、契约不变 | §2.4 + §6 + §8 DoD |
| CI:install→typecheck→build→test | §7.3 |
| lint/format + lint 脚本 + CI 同步 | §7.2(biome)+ §7.3 |
| 纯逻辑/I/O 分离 + state-view 范本入架构文档 | §3.3 + §10(docs/architecture.md,PR-0 落地) |

## 12. 关联

- 本文是 issue #61 的技术架构逻辑;执行按 §8 PR 序列进行,每个 PR 独立提审,拆分与功能开发(如 #14 手机端)不混 PR。
- 产物文件:本设计文档;PR-0 落地 README 维护者节、docs/architecture.md、门禁脚本与 CI。
