# ADR-0002：权威事实与缓存边界

> Status: Accepted | Date: 2026-08-26

## Context

GitHub 请求昂贵，本地 workflow 又需要恢复能力；若为减少请求而让缓存决定状态，会出现 stale review、错误按钮和错误合并。

## Decision

Git/GitHub 原生状态决定代码与协作事实；本地任务所有权由 live handle、`ctx.jobs` 和持久租约共同回答；workflow、事件和 REST 缓存只保存 ClickVibe 自有事实或增强证据。缓存采用短 TTL、请求合并、写后失效和关键门禁强制刷新。

## Trade-offs and failure modes

关键路径仍会产生不可缓存请求，这是正确性成本。GitHub 不可用时应展示已有数据并标记 freshness/unknown，不得用缓存伪装 current。
