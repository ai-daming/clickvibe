# ClickVibe 产品演进路线

> Status: Accepted | Updated: 2026-08-26 | Current execution: [v0.2.0 Milestone](https://github.com/ai-daming/clickvibe/milestone/2) / [Tracking Issue #132](https://github.com/ai-daming/clickvibe/issues/132)

本文是版本方向、先后依赖、用户结果和退出标准的唯一事实源。架构约束以[当前有效架构](architecture.md)和 Accepted ADR 为准；GitHub Milestone 只保存一句范围摘要并链接本文，Tracking Issue 只管理当前版本的切片、依赖和退出证据。

```text
Roadmap 定方向和退出标准
→ Milestone 聚合版本范围
→ Tracking Issue 管切片、依赖和证据
→ 普通 Issue 定一个可验收纵向工作
→ PR / exact SHA 提供实现与审查证据
→ Tag / Release 宣布实际交付
```

## 排序原则

1. 身份先于缓存键、请求归属和迁移。
2. 安全网不晚于自主能力；最小 Policy、因果证据和纯规则 Loop Guard 与自主交付同版本。
3. 完整恢复与复盘不晚于多 Work Item 并行。
4. 规则先于模型；Runtime Observer 是可选诊断能力，不是事实源或动作权限。
5. Local Git、Remote Git 和 GitHub REST 分平面治理，不建立万能中央队列。
6. 每个版本必须产生用户可见结果；核心契约是否泄漏 GitHub 专属类型是每版本固定审计项。

## 演进主线

| 版本 | 主矛盾 | 用户可见结果 | 退出标准 |
|---|---|---|---|
| v0.1.0 | 证明 Issue→Coding→Review→PR/merge 基本流程可工作 | 有一个可运行的实验基线 | 作为实验版本冻结，不获得永久兼容特权 |
| v0.2.0 | 身份、Git/GitHub 请求和事实读取缺少稳定地基 | 并行刷新不再被重复 `git`/`gh` 调用明显拖垮，面板能解释缓存与新鲜度 | Identity、ProjectBinding、WorkItemContract 与三个访问平面落地；Controller 请求可计量；写后重读；每类已切换状态只有一个写入模型 |
| v0.3.0 | 单 Work Item 仍需人逐步点击，自动化可能空转 | 用户交付一个 Issue 后可以离开；系统最终合并或带证据明确暂停 | 最小 Policy、DeliveryBasis、WorkflowControlState、CapabilityLease、EventEnvelope 因果链和纯规则 Loop Guard 与自主交付同版本落地 |
| v0.4.0 | 自主交付失败后难恢复和复盘 | 用户能还原系统观察、决策、动作、验证和错误，并从中断点安全恢复 | 完整 Decision→Action→Re-observe 因果链；错误不埋葬；恢复不重复已确认的外部副作用 |
| v0.5.0 | 多 Issue 并行时 baseline、冲突和合并顺序互相影响 | 同仓库多个 Work Item 可并行推进，冲突在受控流程内自动收敛 | Remote Git 按仓库协调；合并前重取 baseline/head；冲突、重审和合并顺序可追溯且不串扰 |
| v0.6.0 | Loop Guard 能停机，但人工介入仍缺少产品化体验 | 用户能在面板查看暂停证据、修改指令并从受控位置恢复 | 暂停证据展示、恢复和指令修订必交付；模型 Runtime Observer 仅在数据证明有效时启用，且无动作权限 |
| v0.7.0 | 权限、预算、模型和合并边界散落 | 用户能选择自动化程度并理解允许与阻止原因 | Policy 版本化；授权快照可审计；高风险动作受 CapabilityLease 和事实门禁约束 |
| v0.8.0 | 重复失败经验无法安全转化为系统方法 | 经过验证的流程改进可以受控进入新任务并可回滚 | 协议候选来自跨任务证据，经过隔离验证、独立 Review、版本化发布和回滚演练 |
| v0.9.0 | Provider 中立仍是设计假设 | 接入第二个真实 Work Item Provider 时不推翻核心交付模型 | 第二个 Adapter 完成端到端交付；必要时通过 superseding ADR 修正身份假设 |
| v0.10.0 | 长期升级、回滚和运行证据不足 | ClickVibe 可作为持续运行的交付控制面，而不是实验工具 | 安装、升级、迁移、回滚、安全、SLO 和端到端交付均有可重复验证 |

v0.10.0 仍属于 0.x 演化阶段，不冒充 SemVer 1.0 的永久兼容承诺。

## 当前优先级：v0.2.0

### P0：身份与访问作用域

- 落 `WorkItemIdentity(provider/instance/container/id)`，四个字段均为字符串。
- 落 ProjectBinding，把 provider 容器绑定到本机稳定 `repositoryId`、当前 path 和 primary remote。
- 静态枚举 Controller-owned 与 Agent-owned 的 Git/GitHub 调用；前者必须进入受控平面，后者保留完成 Coding、Review 和冲突解决所需权限，但不能冒充已被统一缓存治理。

### P1：三个访问平面

- **Local Git Snapshot**：按 worktree/repository 形成刷新周期内不可变快照；本地动作、任务完成和 remote 协调后确定性失效。
- **Remote Git Coordinator**：按 repository/remote 协调 `fetch`、`push`、`ls-remote` 等共享远端操作，定义队列、串行化、失效和写后重读。
- **GitHub REST Gateway**：按 account/provider instance/repository/operation 管理优先级、singleflight、TTL/ETag、rate-limit 和写后失效。

Controller-owned 调用必须经过对应平面。Agent 可以直接使用真实 `git`/`gh` 工具；ClickVibe 优先提供 ObservationBundle 减少重复探测，并在 push、PR 更新、Review、merge 等关键动作后重新观察权威事实。

### P2：Work Item 契约与最小证据

- 落 WorkItemContractSnapshot、规范化 fingerprint 和原始 ArtifactRef。
- WorkItemContract 留在 v0.2，因为新的读取、授权、Coding 和 Review 路径需要共享同一需求快照、freshness 与失效语义；v0.1 `issueSnapshot` 不进入 v0.2 active state。
- v0.2 按 ADR-0009 对本地 config/state 做显式 clean break：旧 state 整体冷备份但不进入 active runtime；不迁移 legacy WorkflowEvent，也不建立完整自主决策事件总包。判别式 EventEnvelope 及首条 Decision→Action→Re-observe 因果链在 v0.3 随真实生产者落地。
- 所有被捕获、降级或归类的错误保存 DiagnosticRecord 与原始证据引用。

### P3：迁移与退出验收

- v0.1 代码资产逐项决定保留、重构、归档或废弃；本地 config/state 依 ADR-0009 先精确预览和备份，再切换到单一 v0.2 schema。冷备份不参与运行，也不自动删除。
- Git worktree、branch、commit、dirty/conflict 和 Provider 事实不属于旧 state：升级只盘点并保留，既有现场冲突时阻止新任务，不自动导入、删除、reset、stash 或 push。
- 每类已切换状态只有一个写入模型；尚未进入 v0.2 的状态类别不得冒充已完成切换，新旧结构不得长期双写。
- 并发验收在编码前冻结 Work Item 数、请求基线和目标阈值；记录总请求、上游请求、命中率、P50/P95 等待、rate-limit 消耗和失败数，禁止验收后补阈值。

## v0.3 与 v0.6 的介入边界

- **v0.3 最小暂停出口**：持久化暂停原因、最低完整证据和明确下一步，能够安全进入 `human-required`。
- **v0.6 介入产品化**：人在面板查看冻结证据和失败母题，修改指令、选择恢复点，并在恢复前重新观察权威事实。
- 模型 Runtime Observer 只是 v0.6 的可选增强；没有数据证明它能降低人工时间时不启用，但不影响 v0.6 介入产品化交付，也不阻塞 v0.7。

## 展开规则

- 当前 Milestone 创建完整实施 Issue；下一版本只保存候选；更远版本只维护目标与退出标准。
- 每个 Issue 只交付一个可独立测试、Review 和回滚的纵向切片。
- 未达到当前版本退出标准，不靠增加后续概念推进版本号。
- GitHub Milestone 描述只写一句目标、用户结果、退出标准摘要和本文链接；完整标准始终以本文为准。
- Tracking Issue 不复制架构契约，只保存当前切片、依赖、进度和退出证据索引。
- 每个版本结束时审计核心契约是否泄漏 GitHub 专属类型。
