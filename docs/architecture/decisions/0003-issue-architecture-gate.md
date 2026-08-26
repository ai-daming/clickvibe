# ADR-0003：业务 Issue 与架构设计分层

> Status: Accepted | Date: 2026-08-26

## Context

业务 Issue 直接进入快速 web coding 时，每个 Agent 都会局部优化当前验收标准，并分别发明状态、缓存、权限和错误处理，长期必然形成架构腐化。

## Decision

Issue 保持业务导向，但必须标记架构影响等级。L0/L1 遵循现有架构直接开发；L2 先形成跨模块设计或 ADR；L3 在 coding 前明确事实源、不变量、原子边界、失败模式、迁移与回滚，并由设计 PR 先进入 baseline。

## Trade-offs and failure modes

高影响变化启动更慢，但并行实现更稳定。禁止把所有 Issue 都升级为重型设计，也禁止用“以后再整理”绕过 L2/L3。
