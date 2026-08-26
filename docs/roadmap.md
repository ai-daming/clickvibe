# ClickVibe 产品演进路线

> Status: Accepted | Updated: 2026-08-26 | Current execution: [v0.2.0 Milestone](https://github.com/ai-daming/clickvibe/milestone/2) / [Tracking Issue #132](https://github.com/ai-daming/clickvibe/issues/132)

本文记录版本之间的主矛盾、先后依赖与退出标准。架构约束以 [当前有效架构](architecture.md) 和 Accepted ADR 为准；GitHub Milestone 是执行视图，Issue 是可验收工作，PR/Tag/Release 是实际交付证据。

```text
Roadmap 定方向
→ Milestone 定版本边界
→ Tracking Issue 管切片和依赖
→ 普通 Issue 定可验收工作
→ PR 提供实现证据
→ Tag / Release 宣布实际交付
```

## 演进主线

| 版本 | 主矛盾 | 退出标准 |
|---|---|---|
| v0.1.0 | 证明基本 Issue→Coding→Review→PR/merge 流程可工作 | 作为实验基线冻结，不获得永久兼容特权 |
| v0.2.0 | 统一请求入口、身份、事实、证据与核心数据 | 并行压力下可持续取得权威事实；当前状态只有一个写入模型 |
| v0.3.0 | 单 Work Item 自主交付 | 无人逐步点击即可 merged，或带证据明确暂停 |
| v0.4.0 | 多 Work Item 并行协调 | baseline 漂移、冲突和合并顺序可自动收敛 |
| v0.5.0 | 可观测、恢复与复盘 | 能从持久证据还原完整 Decision→Action→Re-observe 因果链 |
| v0.6.0 | 运行时循环监督 | Loop Guard 可确定性停机，Runtime Observer 只介入一次验证轮 |
| v0.7.0 | 策略化工程治理 | 权限、合并、模型、预算和门禁均由版本化策略控制 |
| v0.8.0 | 工程方法改进 | 跨任务协议候选经过隔离验证、Review 和可回滚变更后生效 |
| v0.9.0 | 第二 Provider 验证 | 新增真实 Provider Adapter 而不推翻核心领域契约 |
| v0.10.0 | 产品化稳定基线 | 升级、迁移、回滚、安全和端到端交付具备长期运行证据 |

v0.10.0 仍属于 0.x 演化阶段，不冒充 SemVer 1.0 的永久兼容承诺。

## 当前优先级：v0.2.0

并行度越高，GitHub/gh 请求竞争、限流、重复读取和等待越先成为系统瓶颈。因此 v0.2 不先铺开全部 Domain，而按以下顺序实施：

1. **P0 请求治理**：枚举并计量全部 GitHub/gh 与本地 Git 请求；统一 GitHub REST Gateway；实现并发去重、排队合并、优先级、TTL/validator 缓存、写后失效和关键门禁强制刷新；建立刷新周期内不可变的 Local Git Snapshot。
2. **P1 判断基础**：落 WorkItemIdentity、WorkItemContractSnapshot、DeliveryBasis、WorkflowControlState、generation 与 CapabilityLease。
3. **P2 事件与切换**：落 EventEnvelope、DiagnosticRecord、ArtifactRef；对 v0.1 资产逐项决定保留、重构、迁移、归档或废弃；完成单一事实源切换与架构一致性审计。

v0.1 代码没有保留特权，重写也没有天然优先级。能证明符合目标不变量的能力继续使用；形成错误抽象、多事实源或阻碍演进的部分可以删除或重写。用户数据、原始错误、历史 Review 和交付证据不得静默丢失。

## 展开规则

- 当前 Milestone 创建完整实施 Issue；下一版本只保留候选；更远版本只维护目标与退出标准。
- 每个 Issue 只交付一个可独立测试、Review 和回滚的纵向切片。
- 未达到当前版本退出标准，不靠增加后续概念推进版本号。
- Runtime Observer、Protocol Observer 和多 Provider 不得提前反向阻塞 v0.2 的请求治理与核心事实收口。
