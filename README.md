# clickvibe

DSH web 插件:右侧面板输入 GitHub issue / PR 链接,通过本地 `gh` CLI 抓取并以 Markdown 渲染展示；对 open issue 可创建独立 worktree 并启动 Codex/Claude 开发。

## 功能

- 侧栏底部 **GitHub Issue** 按钮(窄栏显示 "GH")开关右侧面板
- 支持 issue(`/issues/N`)与 PR(`/pull/N`)链接
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
  - 任意时刻只有一个「下一步动作」按钮(开发/恢复/同步/Review/返工/合并),由 git 事实推导,不靠易错的 stage 字段
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
| Client | `src/client/index.tsx` | `shell.overlay` 右侧面板 + `sidebar.footer.action` 开关按钮,`fetch('/clickvibe/api/fetch')` 取数;状态视图 + 唯一动作按钮 |
| 构建 | `tsdown.config.ts` | host → `lib/index.js`(ESM),client → `lib/client.js`(CJS 闭包,`window.__ModuleLoader__.load` 注册) |

Client→Host 走 **HTTP API 路由**(正式插件没有动态插件的 `harness.handle`),这是与原型最大的结构差异。

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
