# 开发基线分支选择：首次开发可选 baseline 分支

> 2026-08-23 讨论沉淀。用户确认 **release 分支 / 集成分支开发是刚需**（"否则项目大不了"），stacked 依赖开发其次——因此走**通用版**：首次开发时允许从远端分支中选择开发基线，默认仍是 origin/HEAD。
>
> 配套 [state-model.md](../state-model.md) §二/§七（对比对象与展示）与 [issue-contract.md](../issue-contract.md)（依赖契约联动）。

## 目标与边界

**现状**：`ensureWorktree`（src/index.ts:2279-2299）写死从 fetch 后的 `origin/HEAD`（兜底 `origin/main`）创建分支，并把 `workflow.baseRef = "origin/main @ hash"` 定格为开发基线。基线在状态模型里**已经是一等事实**（state.ts:63-64、state-model §七「📍 基线」常驻、§二 fork 点/应同步基线）。

**结论**：把 baseRef 的取值来源从"写死"开放为"首次开发时显式指定"，默认路径零变化。设计上让**全链路行为（落后对比、同步对象、review base、PR compare URL）统一从 baseRef 推导**，而不是新增第二套"基线"概念——这是本设计能保持低成本的根因。

**边界**（对齐现有硬原则）：

1. **默认零摩擦**：默认值永远是 origin/HEAD；选择器收在「高级」折叠里。auto-pick 与 dryrun 永远走默认，不弹选择。
2. **仅首次开发可选**：baseRef 已定格（非 null）→ 拒绝改基线请求。想换基线 = 删除分支/worktree 重建，属另一功能，本设计不提供（"基线永远不变"）。
3. **只接受远端事实**：基线必须是 fetch 后的 `origin/*` 分支（校验 ref 存在），不接受本地任意 HEAD/自由文本——延续"新分支只从 fetch 后的远端创建"的安全边界。
4. **与依赖契约联动**：基线命中已知 issue 开发分支时建议补 `Blocked by #N`，保持自动选取判定诚实。

## 交互设计（src/client/index.tsx + authorize 预览）

「开始开发」的授权预览框（authorizeAgent，src/index.ts:1680-1721）内新增：

- 该 issue **未开发过**（baseRef 为 null）→ 显示「高级：开发基线」下拉：
  - 第一项固定 `origin/HEAD（默认）`；
  - 其余选项 = 预览时 fetch 后的 `origin/*` 分支（排除重复项，列表由服务端 preview 返回）；
  - 某 issue 的开发分支尚未 push 时不在列表 → 提示"先把父分支推上去"。
- 已开发过 → 下拉禁用，显示「基线已定格：origin/x @ hash；换基线需删除分支重建」。
- 选择写入 `payload.baseline`；**authorizeAgent 的预览快照增加 baseline 字段**，startDevelop 校验一致（同现有 url/state 的 fail-closed 校验逻辑，src/index.ts:2635）。

## 服务端改动清单

| 位置（src/index.ts） | 现在 | 改为 |
|---|---|---|
| `ensureWorktree` 2279-2299 | 固定 origin/HEAD → 兜底 origin/main | 接受 `payload.baseline`；fetch 后 `git show-ref --verify refs/remotes/origin/<baseline>` 校验，不存在则拒绝；`remoteBase = origin/<baseline>`；**baseRef 已存在且与请求不一致 → 拒绝（"基线已定格"）** |
| `startDevelop` 2598 | 不透传 baseline | 透传并校验与授权快照一致；launchSnapshot 绑定 |
| 落后/领先 721-749 | `readRefShort(origin/main)` 与 HEAD 对比 | 改读基线远端分支 `origin/<workflowBaseBranch(baseRef, defaultBranch)>`（baseRef null → origin/HEAD）；needsSync / hasCommits 语义不变，默认情形完全等价 |
| 同步动作 2958-3004 | `git merge --no-edit origin/main` | merge 基线远端分支；返回文案同步（3004 "已同步到 origin/x"） |
| review base 兜底 2116-2120 | 无 PR 时 base = origin/main | 无 PR 时 base = 基线远端分支（PR baseRefName 仍优先）；buildReviewPrompt 注释同步 |
| prompt 文案 677 / 2081 / 3362 附近 | "落后 origin/main / 合并 origin/main" 写死 | 用 `workflowBaseBranch(workflow.baseRef)` 生成，默认情形文案不变 |

**已就位、无需改**：`workflowBaseBranch`（state-view.ts:29-33）早已解析 `"origin/x @ hash"`；`githubCompareUrl`（:35-43）已按 baseRef 生成 compare URL → 建 PR 入口天然指向基线分支；merge 门禁 head-check（index.ts:1783）已 baseRef-aware。

**文档注释**：state.ts:63-64 baseRef 注释更新为"可为任意远端分支"。

## 边界与降级

- **基线远端分支被删除**：📍 基线仍显示定格 hash；落后/同步显示 ⚠「基线分支已不存在」，不做同步（不阻塞 review/merge；merge 门禁照旧）。
- **baseline == 默认分支**：等价于现状，多余字段无害。
- **旧数据 baseRef 缺失**：`workflowBaseBranch` 退化 defaultBranch，行为不变。
- **跨机器（#11）**：baseRef 是本地 git 事实且含定格 hash；任意执行机 fetch 后 `origin/<base>` 可解析，可审计性不变。

## 合并顺序与 retarget（stacked 场景）

- B 基于 A 的开发分支建 PR → PR base 默认 = A 分支（compare URL 已按 baseRef 生成）。
- A 合并后清理链删除 A 分支（merge-and-cleanup-design 既有流程）→ GitHub 将 B 的 PR **自动 retarget 到仓库默认分支**，无需手工。
- 若 A 分支被保留未删 → B 的 PR 仍指向 A；合并顺序由人把关（合并本就是人工动作），merge 前置门禁不变。
- review diff：stacked 期含父提交是正确的整体语义；A 合并、B retarget 后，下一次 re-review 自然只看增量。

## 依赖契约联动

基线分支名解析到某 open issue 的开发分支（`clickvibe-issue-<N>` 或等价约定）→ 客户端预览框提示「建议补 `依赖: Blocked by #<N>`」，可一键写入 issue 正文（走 gh-issue 契约，写后回读验证——既有地层）。**自动选取判定不变**：auto-pick 永远走默认基线；已手动选基线的 issue 若缺 Blocked by，自动选取仍可能误选 → 这是联动存在的意义。

## UI 展示

- 详情「📍 基线」已显示 `origin/<branch> @ hash`，无需改。
- 落后徽章文案：默认情形不变；自定义基线时显示「落后 origin/release-2.0 N」。state-model §七"对比对象只有一个 origin/main"改为"对比对象 = **基线远端分支**（默认 origin/HEAD）"。

## 测试清单

- `workflowBaseBranch`：`origin/release-2.0 @ abc` → release-2.0；`origin/HEAD` → defaultBranch；null → defaultBranch（扩展现有 state-view.test.ts）。
- `ensureWorktree`：合法 baseline 建分支、非法 ref 拒绝、**baseRef 定格后改基线请求拒绝**、baseline==默认等价。
- 落后/领先对比对象 = 基线远端分支；默认情形回归断言不变。
- 同步动作 merge 对象 = 基线分支；冲突文案含基线名。
- review base 兜底 / prompt 快照文案。
- authorize 预览含 baseline 字段；startDevelop 快照一致性校验；client 下拉禁用逻辑（已开发过）。
- 契约联动：基线命中 issue 分支 → 建议 Blocked by。

## 工作量与风险

- 纯函数/数据层改动小（`workflowBaseBranch` 已就位）；主要成本 = ensureWorktree 参数化 + 各处写死 origin/main 的替换 + client 下拉。
- 回归风险的唯一要害是"**默认情形行为完全不变**"——所有替换必须经 `workflowBaseBranch` 推导，测试重点覆盖默认路径。
