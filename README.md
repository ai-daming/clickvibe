# clickvibe

DSH web 插件:右侧面板输入 GitHub issue / PR 链接,通过本地 `gh` CLI 抓取并以 Markdown 渲染展示。

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

## 架构

| 半侧 | 文件 | 职责 |
|---|---|---|
| Host | `src/index.ts` | 注册 `/clickvibe/api` 前缀路由,POST `/fetch` 调 `gh`,返回 `{ ok, data }` 信封 |
| Client | `src/client/index.tsx` | `shell.overlay` 右侧面板 + `sidebar.footer.action` 开关按钮,`fetch('/clickvibe/api/fetch')` 取数 |
| 构建 | `tsdown.config.ts` | host → `lib/index.js`(ESM),client → `lib/client.js`(CJS 闭包,`window.__ModuleLoader__.load` 注册) |

Client→Host 走 **HTTP API 路由**(正式插件没有动态插件的 `harness.handle`),这是与原型最大的结构差异。

## 开发

```sh
pnpm install
pnpm run build     # tsc 声明 + tsdown 双 bundle
pnpm run watch     # client 热更新
```

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
```
