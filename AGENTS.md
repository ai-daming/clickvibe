# AGENTS.md — ClickVibe 代码治理(改动代码的 Agent 必读)

> 本文件定义任何 agent / 维护者在 ClickVibe 仓库改代码时必须遵守的结构规则、契约红线与开发方法论。完整设计出处:`docs/plans/2026-08-23-domain-split-architecture-design.md`(issue #61 技术架构逻辑)。

## 0. 项目是什么

ClickVibe 是一个 DSH Web 插件:右侧面板把 GitHub issue 变成「开发 → review → 返工 → 合并」的异步流水线,git + GitHub 是唯一事实源,merge 留给人拍板。宿主侧(server)与客户端(client)分居 `src/index.ts` 与 `src/client/index.tsx` 两个 bundle 入口(构建与产物见 `tsdown.config.ts`)。

### 主仓库开发守则

直接在主仓库 checkout 工作的 agent,开始任务前必须先执行 `git fetch origin --prune`,检查遗留冲突(`MERGE_HEAD`)、工作区状态与本地分支落后情况;先同步最新代码并解决冲突,再开始任务。禁止用自动 stash、rebase 或丢弃改动绕过现场。

## 1. 结构三规则(issue #61,机器门禁守护)

**规则一:每文件 ≤500 行(>800 无条件拆)。**
- 以物理行数计;`(500, 800]` 必须可解释:文件首行注释写明理由,或登记 `scripts/file-size-exceptions.json`;>800 直接拒绝。
- 新代码禁止制造超限文件;拆分动作=纯搬移+分层,不得把函数劈成两半跨文件。

**规则二:目录按领域组织,模块依赖单向。**
- 四层架构,层号即依赖上限,文件只能 import 层号 ≤ 自身的模块:

| 层 | 目录 | 职责 | 禁止 |
|---|---|---|---|
| 0 | `src/infra/` | I/O 适配:HTTP 传输、shell/git、进程监督、持久化、流编解码、TTL 门 | import 上层 |
| 1 | `src/github/` | GitHub 适配:`gh api` 读写、REST 映射、仓库/issue/pr/依赖读取 | import workflow/agent |
| 2 | `src/agent/` | agent 会话:命令构建、授权、提示词、worktree 保障 | import workflow |
| 3 | `src/workflow/` | 业务流程(use cases):推导、合并门禁、命令 handler、开发/review 编排 | —(可依赖全部下层)|
| 4 | `src/index.ts` | 合成根:路由注册 + 薄 handler 分发表 + re-export 锚点 | 写业务逻辑 |

- `src/client/**` 自成一体,不得 import `src/**`。

**规则三:纯逻辑与 I/O 分离(范本 `src/state-view.ts`)。**
- 推导/映射/格式化必须是**纯函数**(同输入必同输出,无 shell/fs/网络/时钟/进程句柄);
- 函数触碰 `ctx.shell` / `fs` / `http` / `child_process` / `Date.now` / `randomBytes` / 进程句柄 / 外部包 即为 I/O 函数 → 落 `infra/` 或 `github/` 适配层;
- 纯函数 → 落 workflow / agent 的纯逻辑文件,并配纯逻辑测试(无沙箱依赖)。

## 2. 开发方法论(所有新代码必须遵守)

**2.1 TDD(测试先行)。**
- 任何新功能 / 修复:**先写失败测试(red)→ 最小实现(green)→ 重构(refactor)**;禁止"先写实现后补测试",更禁止"实现完再写测试凑数"。
- 测试是行为契约,不是附属品;拆分 / 搬移同样要求先有覆盖其当前行为的测试,搬家后行为回归由测试证明。

**2.2 覆盖率 ≥85%。**
- 交付标准:全部测试的**语句/行覆盖率 ≥85%**,以 CI 报告为准;不可用"删断言 / 缩测试范围"来凑数值。
- 测量:node 内置覆盖率(node ≥22 的 `--experimental-test-coverage`,node 23+ 建议 `--test-coverage` 系列),阈值参数(`--test-coverage-statements=85` 等)在门禁 PR 中按实际 node 版本固化进 npm script 与 CI(见 §5);覆盖率不足 = CI 红 = 未完成。

**2.3 不用 mock,用真实业务代码。**
- 新测试**禁止用 mock 库桩掉被测业务逻辑**;倾向:真实实现 + 真实 git / gh 环境,或**最小 fake**(如实名实现同一接口、可注入真实行为的可编程替身)。
- 现状参照:`tests/routes.test.ts` 对 `ctx.shell` 的注入是 fake shell(拦截 `gh api` 的可编程替身),它保留真实调用路径与返回形状,不是"mock 掉行为",维持此模式;真实 git 集成测试参照 `tests/worktree-integration.test.ts`。
- 判定:若为了测某单元必须桩掉其大半行为 → 先重构被测代码(提取纯函数、依赖注入),而不是上 mock 掩盖。

**2.4 YAGNI(不做预测性设计)。**
- 只实现当前需求与验收标准要求的东西;不预建抽象、不提前添加"以后可能用上"的 hook / 泛型 / 配置项 / CLI 参数。
- 拆分以现状功能簇为准**搬移与分层**,不为"整齐"重写或凭空引入新层;抽象只在出现第二个真实使用方时才提取。
- 与雷区呼应:框架 / 校验库等依赖,直到重复达到门槛(如校验逻辑 ≥3 处)才统一引入。

## 3. 契约红线(违反即返工)

1. **测试全绿**:`pnpm run typecheck && pnpm run build && pnpm test` 必须全绿;拆分 PR 中测试只允许改 import 路径,断言 / fixture / 行为一律不动。
2. **导出面锚点**:以下被测试直接引用的导出必须继续从 `src/index.ts` re-export,不得转移后断供:`apply`、`fetchRepositoryIssues`、`deriveWorkflowState`、`enrichWorkflowStates`、`buildMergePreface`、`resumeDevelop`、`syncWorktree`、`assertReviewHeadMatchesPr`、`isSyncEquivalentMerge`。
3. **构建入口固定**:`src/index.ts`、`src/invariant.ts`、`src/client/index.tsx`(`tsdown.config.ts`),搬移不得移动这三个文件本身。
4. **对外契约不变**:17 个 `/clickvibe/api/*` method(fetch/projects/repo/issues/state/authorize/develop/develop/poll/history/stream/review/resume/stop/sync/merge/command)、响应形状、`~/.clickvibe/state/` 持久化格式、agent 两阶段授权命令(预览→一次性 2 分钟授权→执行)与文本命令语法。
5. **状态推导纪律**:git/GitHub 原生事实是门槛,workflow 文件与 comment meta 只是缓存/增强器(见 `docs/state-model.md`);review 结论必须绑定其审查的 commit 与契约指纹,不得冒充。

## 4. 雷区(不做)

- 不引入 UI 组件库(antd/MUI)、Tailwind/CSS Modules、xstate/redux/tanstack-query/react-router;
- `zod` 等运行时校验库仅在拆分后仍存在 ≥3 处重复校验逻辑时才引入(统一边界层);
- 拆分与功能开发不混在同一 PR;不删除、不重写既有业务逻辑,只搬移与分层;
- 新测试不引入 mock 库(§2.3);不为凑覆盖率删测试或缩断言(§2.2);不做预测性抽象(§2.4);
- 不把面板暴露到局域网/公网——真实 agent 只接受本机回环、同源、带专用请求头的请求。

## 5. 工程流程与门禁

- 本地交付链:`pnpm install && pnpm run typecheck && pnpm run build && pnpm test`,再跑覆盖率(≥85%)、`pnpm run lint`(biome)、`pnpm run check:size`(行数门禁);四者全绿才算完成。
- 覆盖率命令(以仓库实际 node 版本为准,门禁 PR 固化):
  - node ≥22:`node --experimental-test-coverage --test tests/*.test.ts`(报告);
  - node 23+/24 LTS 阈值硬门禁:`node --test --test-coverage --test-coverage-statements=85 --test-coverage-branches=85 --test-coverage-functions=85 --test-coverage-lines=85 tests/*.test.ts`。
- CI(`.github/workflows/ci.yml`)同步执行:typecheck → build → test → coverage(≥85%)→ lint → check:size。
- 提 issue / 评论遵循 `docs/issue-contract.md` 与仓库 mutation 工作流(刷新 → 预览 → 授权 → 回读验证)。
- 功能开发必须动作命令化,保持「面板按钮与对话命令共享同一后端动作」。

## 6. 关联文档

- 领域拆分完整设计:`docs/plans/2026-08-23-domain-split-architecture-design.md`(§3 三规则、§4/§5 目标结构、§7 门禁、§8 PR 序列)
- 状态模型与按钮决策:`docs/state-model.md`;命令参考:`docs/command-reference.md`;产品蓝图:`docs/product-blueprint.md`
