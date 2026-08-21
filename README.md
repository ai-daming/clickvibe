# clickvibe

DSH web 插件:右侧面板先选择已配置的 GitHub repo,再按依赖、状态和里程碑浏览全部 open issue；每个 issue 由 git/GitHub 硬事实推导唯一下一步动作,可创建独立 worktree 并启动 Codex/Claude 开发。

## 功能

- 侧栏底部 **ClickVibe** 按钮(窄栏显示 "CV")开关右侧面板
- 项目选择器读取 `~/.clickvibe/config.yaml` 的全部 repo 映射,路径不在本机的跨机器配置也保留在列表
- 选中项目后展示全部 open issue,支持按里程碑或依赖状态分组、按依赖就绪/阻塞过滤
- 每行展示状态徽章、约定分支、落后提示、milestone、blockedBy 与唯一动作；点开后进入完整详情
- **blockedBy 门槛**:有 OPEN 依赖时,「开始/恢复开发」替换为「被 #N 阻塞」(禁用);review/返工/合并等已开发流程不受影响
- **就绪优先排序**:组内按 就绪(未开发+依赖OK)→ 开发中 → 阻塞 → 已交付 排列,同档按编号;一眼看到能下什么单
- Host 半通过 `gh issue view` / `gh pr view` 抓取,返回结构化 JSON
- Client 半渲染:
  - 状态徽章(Open / Closed / Merged)、编号、作者、创建/更新/关闭/合并时间
  - labels、assignees、milestone
  - PR 额外:分支 `base ← head`、变更统计、提交数、合并状态
  - 正文与评论:轻量 Markdown 渲染器(标题/粗斜体/代码块/列表/引用/链接),评论默认展开
  - 整块内容区一个滚动条(GitHub 风格)
- **权威状态视图**(#5):每次请求实时推导
  - 三方对比:worktree / main / 远端(origin/main、远端同名分支)的哈希与 ahead/behind
  - worktree 落后远端时提示「需要同步」并提供 /sync 动作(fetch + merge origin/main,冲突自动回滚)
  - review 结论标注它审查的 HEAD;HEAD 变化后自动显示「结论已过期」,不冒充当前状态
  - 任意时刻只有一个「下一步动作」按钮(开发/恢复/同步/创建 PR/Review/返工/合并),由 git 事实推导,workflow 文件只做增强
  - PR 状态每次从 GitHub 查询；merged 立即进入已交付终态,查询失败则 fail-closed,不沿用旧的合并按钮
- Open issue 一键开发:
  - `Codex 开发` / `Claude 开发`:在 issue worktree 中启动非交互 agent
  - `安全演练`:走完整 worktree/任务/轮询链路,只执行 `pwd`、当前分支和 `git status`
  - 真实 Agent 启动只接受本机回环、同源且带专用请求头的请求；服务端冻结面板已展示的完整 Issue 快照,签发两分钟内一次性授权,启动时不再重新抓取 Issue
  - 日志按完整行、cursor 增量轮询；服务端与面板最多保留 2000 行,持久日志也有大小上限,超出时明确提示截断
  - Agent 最长运行 10 分钟,面板可主动停止；完成任务延迟回收,任务表本身有总量上限
  - 已有正确 worktree/分支会复用；缺分支、缺 worktree 或 detached 等半完成状态会安全恢复
  - 创建或修复缺失分支前先 `git fetch origin --prune`,并显式从 `origin/HEAD`(兼容回退 `origin/main`)创建,不继承配置仓库当前 HEAD
  - 冲突分支或未注册的非空目录不会被覆盖

## 架构

| 半侧 | 文件 | 职责 |
|---|---|---|
| Host | `src/index.ts` | 注册 `/clickvibe/api` 前缀路由,处理 GitHub 抓取、开发任务和 cursor 日志轮询 |
| 开发内核 | `src/develop.ts` | agent/URL 校验、shell 参数转义、有界行日志和 worktree 恢复决策 |
| 状态视图 | `src/state-view.ts` | 纯函数 `deriveNextAction`:由 git 事实 + 事件历史推导唯一下一步动作 |
| Client | `src/client/index.tsx` | `shell.overlay` 项目优先面板 + `sidebar.footer.action` 开关按钮；项目 issue 列表、筛选/分组、详情和唯一动作 |
| 构建 | `tsdown.config.ts` | host → `lib/index.js`(ESM),client → `lib/client.js`(CJS 闭包,`window.__ModuleLoader__.load` 注册) |

Client→Host 走 **HTTP API 路由**(正式插件没有动态插件的 `harness.handle`),这是与原型最大的结构差异。

## 设计文档

| 文档 | 内容 |
|---|---|
| [docs/state-model.md](docs/state-model.md) | **状态模型**:事实分级(git/GitHub 硬事实 vs 软事实)、按钮决策表(P0-P3)、软事实降级链、状态视图展示规范 |
| [docs/issue-contract.md](docs/issue-contract.md) | Issue 契约:可被自动开发的 issue 写法(目标/验收标准/依赖 三行最小集) |
| [docs/product-blueprint.md](docs/product-blueprint.md) | 产品蓝图:里程碑驱动的异步开发执行器定位、架构、UI 演进 |

核心设计原则:**判断只依赖 git/GitHub 硬事实**(客观、保证存在),workflow 文件与 comment meta 只是增强器——允许缺失,缺失时走降级链,永不因缺 meta 卡死,也永不因缺判据瞎猜。

## Agent 启动参数(显式,不依赖机器配置)

ClickVibe 启动 agent 的命令行**按次显式传参**,不读取也不假设目标机器的全局配置(#11 跨机器可移植):

- claude:`--dangerously-skip-permissions`
- codex:`-c approval_policy=never -s danger-full-access`(新会话)/ `-c 'sandbox_mode="danger-full-access"'`(resume 子命令无 `-s`,用 `-c` 覆盖)

## 进行中(open issues)

- [#16](https://github.com/ai-daming/clickvibe/issues/16) 实时输出 TUI 化 + detach 放大 + 运行时长 + token 用量
- [#17](https://github.com/ai-daming/clickvibe/issues/17) 超时/中断后会话恢复(会话 id 捕获 + resume 命令形式)
- [#18](https://github.com/ai-daming/clickvibe/issues/18) 任务超时上限可配置,支持小时级长任务
- [#20](https://github.com/ai-daming/clickvibe/issues/20) 提示词统一:各阶段自带需求快照
- [#22](https://github.com/ai-daming/clickvibe/issues/22) review 结论解析器支持 JSON 格式
- [#23](https://github.com/ai-daming/clickvibe/issues/23) 合并后清理(worktree/分支/issue/workflow)

## 开发

```sh
pnpm install
pnpm run build     # tsc 声明 + tsdown 双 bundle
pnpm test          # Host 纯逻辑回归测试
pnpm run watch     # client 热更新
```

## 一键开发配置

配置文件固定为 `~/.clickvibe/config.yaml`：

```yaml
repos:
  ai-daming/clickvibe: /Users/me/work/clickvibe

worktreeRoot: ~/.clickvibe/worktrees
```

仓库按 `owner/repo` 精确匹配。目标路径为 `<worktreeRoot>/<仓库目录名>/<仓库目录名>-issue-<N>`，分支名为 `<仓库目录名>-issue-<N>`。

## 安装到 profile

```sh
dsh plugin --profile web add link:/Users/yinwm/work/clickvibe
```

- client 半改动:**硬刷新浏览器**(⌘⇧R)即可
- host 半改动:重启 `dsh web`

## 验证

```sh
# host 路由
curl -X POST http://127.0.0.1:3080/clickvibe/api/projects \
  -H 'content-type: application/json' -d '{}'

curl -X POST http://127.0.0.1:3080/clickvibe/api/repo/issues \
  -H 'content-type: application/json' \
  -d '{"repoKey":"ai-daming/clickvibe"}'

curl -X POST http://127.0.0.1:3080/clickvibe/api/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/cli/cli/issues/100"}'

# client bundle
curl http://127.0.0.1:3080/plugins/clickvibe/client.js

# 启动无代码副作用的 dry-run
curl -X POST http://127.0.0.1:3080/clickvibe/api/develop \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/ai-daming/clickvibe/issues/1","agent":"dryrun"}'

# 同步 worktree 到远端基线(fetch + merge origin/main,冲突自动回滚)
curl -X POST http://127.0.0.1:3080/clickvibe/api/sync \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3080' \
  -H 'x-clickvibe-request: 1' \
  -d '{"url":"https://github.com/ai-daming/clickvibe/issues/5"}'

# 用启动响应中的 taskId 和 poll 响应中的 cursor 增量轮询
curl -X POST http://127.0.0.1:3080/clickvibe/api/develop/poll \
  -H 'content-type: application/json' \
  -d '{"taskId":"dev-...","cursor":0}'
```

任务状态只保存在当前 Host 进程内,重启后旧 `taskId` 失效。真实 Agent 必须从面板发起:面板先把当前显示的完整 Issue 快照交给服务端比对,再展示 Agent、更新时间、评论数和快照摘要供确认；确认后的授权只能使用一次且会过期。`dryrun` 不需要高权限授权、不启动 Agent,适合用 curl 验证配置、worktree 恢复和增量轮询。

不要把 ClickVibe 暴露到局域网或公网。服务端会拒绝非回环来源的 Agent 操作,但同一操作系统账号下的恶意进程本来就可能读取代码、配置和开发凭据,本工具不把同账号进程隔离当作安全边界。
