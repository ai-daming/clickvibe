# 项目优先 Issue 面板设计

## 决策

面板入口改为配置仓库选择器。Host 新增项目枚举与 repo issue 聚合接口，一次读取 GitHub issues、PR 及本地 git 事实；Client 只消费聚合结果，不对每个 issue 发 N+1 请求。

## 数据流

1. 项目列表来自 `~/.clickvibe/config.yaml` 的 `repos` 键。路径不在当前机器时仍展示项目，但标记为本机不可用。
2. 选中 repo 后，Host 枚举全部 open issue，同时读取 milestone、正文中的 `blockedBy`、约定分支/worktree、关联 PR 与 GitHub review 状态。
3. 本地 workflow 仅补充会话、事件和运行中任务；缺失时按 repo 路径、worktreeRoot、issue 号构造临时视图，不写缓存。
4. PR `state`、`mergedAt`、`reviewDecision` 每次刷新从 GitHub 查询。已合并 PR 是终态，不再给出合并动作。

## 界面

默认按里程碑分组，可切换为按依赖就绪/阻塞分组，并可过滤依赖状态。每个 issue 一行展示阶段徽章、milestone、blockedBy 和决策表推导的唯一主动作。点击标题进入现有详情；点击主动作先加载完整、最新 issue 快照，再复用现有授权与执行流程。

## 验证

纯状态决策测试覆盖无 workflow 的 idle、残留分支/worktree、已有提交、PR merged。路由测试覆盖 repo 聚合的 issue、依赖、milestone、无 workflow 动作和 GitHub merged 覆盖。最终运行 typecheck、全量测试和 production build。
