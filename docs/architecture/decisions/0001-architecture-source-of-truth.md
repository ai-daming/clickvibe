# ADR-0001：架构文档的权威层级

> Status: Accepted | Date: 2026-08-26

## Context

ClickVibe 的产品、状态、权限和实现设计散落在 blueprint、state model、AGENTS 和按日期保存的 plans 中，无法判断哪份仍然有效。

## Decision

`docs/architecture.md` 是当前架构唯一入口；`docs/architecture/` 保存有效视图；`decisions/` 保存取舍；`plans/` 只保存实施历史。Accepted 设计必须回写正式架构，架构版本使用 Git commit SHA。

## Trade-offs and failure modes

增加了维护成本，但避免 Agent 按历史 plan 施工。若只新增 ADR 而不更新入口，或只改入口而不标记被替代决策，Review 必须拒绝。
