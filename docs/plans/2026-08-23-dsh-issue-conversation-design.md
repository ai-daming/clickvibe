# issue 详情「在 DSH 对话中打开」设计(#53)

> 2026-08-23。issue 详情视图一键在仓库对应的 DSH workspace 新开空白对话,
> 并把 issue 链接预填进输入框草稿(不自动发送)。

## 机制(实现前已对照 deepseek-harness 源码确认)

全部走 DSH 客户端公开服务(`ctx.get(...)` 运行时解析,宿主注入):

1. `workspaces.create({ path })` —— 宿主 `ensureWorkspace` 先
   `resolveByPath`(realpath 规范化,任意拼写均可)再落库,
   **幂等**:已注册则复用,未注册则自动注册。无需先查 list。
2. `workspaces.connectWorkspace(workspaceId)` —— 建/复用该 workspace 的
   空白会话,返回 sessionId。契约明确:返回的会话已进列表、binding 同步
   可解析,**允许先写草稿再导航**。
3. `conversation.input.for(sessions.scope(sessionId)).setDraft(url)` ——
   ui-conversation 的 SessionInput 单一草稿写路径,只改草稿不发送。
4. `sessions.open(sessionId)` —— 导航。

失败语义:workspace/会话创建失败 → 不导航、报可读错误;草稿失败 →
仍导航(session 已可开),再如实报告"草稿未预填"原因;workspaces/sessions
服务缺失 → 直接报缺哪个服务。不静默失败。

## 改动

- `src/client/dsh-conversation.ts`(新)—— 桥接逻辑,服务面用本地结构
  类型描述并依赖注入,纯逻辑可测。
- `src/client/index.tsx` —— `DshOpenButton` 组件(issue 详情渲染,PR 不
  渲染;远程配置禁用并给原因);`apply` 捕获 ctx 供按钮解析服务。
- `tests/dsh-conversation.test.ts`(新)—— 注册幂等、草稿先于导航、
  不发送、三类失败的可读错误、服务缺失命名。

## 边界

- 远程配置(无本机路径):按钮禁用,title 说明原因。
- 仓库未配置:按钮禁用,提示配置路径。
- config 路径含 `~`/symlink:服务端 projects 已展开 `~`;realpath 由宿主
  规范化,幂等不受影响。
