# ClickVibe 产品蓝图

> 2026-08-21 讨论沉淀。目标读者:ClickVibe 后续开发(含自举开发)的参考。

## 一、定位

**ClickVibe = 里程碑驱动的异步开发执行器。**

不是又一个 agent 编排器,不是 IDE。它把"人不在电脑前的时间"变成"有效开发时间":
人用碎片时间做**架构设计 + 落单 + 验收决策**,中间(开发 → review → rework → PR)由 ClickVibe 按依赖图自动施工、跨机器并行执行,全程无人值守。

## 二、为什么自研(相对 orca)

| | orca | ClickVibe |
|---|---|---|
| 心智模型 | 以 worktree / 并行 agent 为中心 | 以 **issue / milestone** 为中心 |
| 场景 | 人在场时,管一群并行 agent | **人不在场**时,按依赖图自动推进 |
| 状态 | 存在工具内部(控制平面) | **git 是事实源**,状态可推导、可审计 |
| 自动化边界 | 交互式编排 | **异步施工 + 人类只在关键节点验收** |

orca 重度用户自研的原因:**要的不是更多并行,而是围绕"一个需求的完整生命周期"的可追溯、有状态、跨机器的异步交付**。orkca 管"agent 干活",ClickVibe 管"需求从 issue 到合并的旅程"。

## 三、核心模型

```
Milestone(交付批次:如"一期自动入群承接系统")
  └─ Issue(工单)── blockedBy ──→ 依赖图(施工顺序 + 并行机会)
       └─ worktree(工位,并行隔离)
            └─ 两台机器(工地:本机 mac + ubuntu 服务器,按环境选择执行地)
```

- **blockedBy + worktree = 并行开发的手段**:依赖图中无依赖的 issue 是天然并行集,各占一个 worktree 同时开发。
- **人的职责只有两端**:
  1. 架构设计:拆 issue、定依赖、排并行 → 产出"施工图"
  2. 验收决策:看结果、点合并、拍板发版 → 消费"施工成果"
- 中间(ClickVibe + agent)按施工图自动施工,无需人。

## 四、架构

```
┌────────────────────────────────────────────┐
│ dsh Web GUI(指挥所)                          │
│  ├─ 讨论:和 agent 想清楚架构/方案(人在)       │
│  ├─ 落单:gh 提 milestone / issue / 依赖(人在) │
│  └─ ClickVibe 面板:                          │
│       [项目选择] → [issue 列表按依赖] → [下单] │
│       → 并行 worktree → 跨机器 → review → PR  │
└────────────────────────────────────────────┘
         │                        │
   本机(mac)                ubuntu 服务器
   执行 agent               执行 agent
```

- **控制面(dsh + ClickVibe 面板)**:手机必须可达(人在碎片时间访问),宜跑在 7x24 在线的 ubuntu,或经 Tailscale/局域网。
- **执行面(施工)**:先单机,后多机(repo → 机器映射)。
- **手机端 = 对话优先**:手机上"要讨论"是刚需,ClickVibe 操作应是**对话可触发的动作**(在对话里说"把 #8 下单开发"),UI 只是入口之一。核心设计约束:**动作命令化,可被对话触发**。

## 五、UI 演进

### 5.1 信息架构:从"贴 URL"到"项目优先"

```
现在:  输入框 → 贴 issue URL → 单个 issue 操作
未来:  [项目选择] → 展示 repo 所有 issue(依赖/状态/里程碑)
      → 按 blockedBy 依赖选择/批量选择 → 触发开发
```

- 项目载体 = GitHub repo(跨机器,各机器配置了该 repo)
- 展示形式(列表/看板/依赖图)待定,信息架构已定:**项目优先、issue 可选择、依赖驱动**。

### 5.2 布局:better-sidebar 式右侧占位展开

**问题**:ClickVibe 当前是悬浮 overlay,会和 dsh 主输入框/内容"打架"(盖在上面,不占位)。

**方案**:学 better-sidebar —— 右侧占位展开,不打架:
- **桌面(≥768px)**:右侧占位(默认 ~25% 宽),主内容被压缩让位
- **手机(<768px)**:全屏 100vw 展开,主内容让位
- 实现:测量主列(ResizeObserver),主列让位,面板占位 —— 直接操作 DOM(如 better-sidebar 的 `document.getElementById('root')` + centerRect 测量)

**架构含义**:这使 ClickVibe 从"受 slot 约束的 overlay"转向"自己控制布局"——面板展开/收起、主列宽度、移动端全屏全部自管(参考 better-sidebar 的 Sidebar.tsx 模式)。涉及 DSH 布局集成,风险高,应作为 ClickVibe 自举开发的独立 issue(已提 #12)。

**参考深挖**(2026-08-22):参考实现已定位为同为 DSH 插件的 `omdsh-dev/DSH-better-sidebar`(`src/client/layout.css` + `Sidebar.tsx`)。核心机制 = 在 `<html>` 写 CSS 变量 → `#root` 的 `margin-right` 消费它让位(用 `calc(100% - var(...))` 兼容 `width:100%` 的 shell);宿主 AppFrame 中心列是 `minmax(0,1fr)` 唯一弹性列,壳被挤窄时回收宽度全落在中心列,让位天然成立;窄屏(<768px,刻意不对齐宿主 1024)抽屉 100vw 悬浮、布局变量恒 0。完整机制、宿主结构事实与 #12 落地建议见 [plans/2026-08-22-sidebar-layout-research.md](plans/2026-08-22-sidebar-layout-research.md)。

## 六、自动化边界(信任设计)

- **自动化**:开发、review、rework、worktree 调度、跨机器派发 —— 全自动
- **人决策**:merge、发版(milestone 拍板)、卡住时的介入 —— 必须人点
- 原因:从 afu 工作流看,用户极在意"版本能不能发"这类判断,这是核心决策权,不可让渡。

## 七、Issue 队列(待开发)
| # | 内容 | 状态 |
|---|---|---|
| #3 | 长任务会话持久化(历史以磁盘为准,SSE 增量) | 待开发 |
| #4 | PR 交付/审查 comment 流水 + UI 重新设计 | 待开发 |
| #5 | 权威状态视图(worktree/main/远端对比、流程推导、唯一动作) | 待开发 |
| #12 | 布局改造:better-sidebar 式右侧占位展开,不打架,手机全屏 | 已提,参考调研完成 |

## 八、设计约束(贯穿所有开发)

1. **动作命令化**:ClickVibe 的每个操作都能被对话触发(为手机端铺路)
2. **状态以 git 为事实源**:不靠易错的 stage 字段,从 git 推导
3. **历史以磁盘为准,SSE 只做增量**(#3 原则)
4. **跨 agent 会话不混**:codex/claude 各自 session id,UI 只显示锁定 agent
5. **评论形成 PR 内流水**(#4):开发完成 / review 结论都发 PR,可追溯

## 九、Issue 契约

可自动开发的 issue 写法(最小集合 = 目标 + 验收标准 + 依赖,分级模板见文档):[issue-contract.md](issue-contract.md)
