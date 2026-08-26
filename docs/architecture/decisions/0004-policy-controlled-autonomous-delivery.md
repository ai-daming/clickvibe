# ADR-0004：策略控制的自动交付与合并

> Status: Accepted | Date: 2026-08-26 | Supersedes: “merge 永远留给人点击”的旧产品原则

## Context

Issue 并行开发必然遇到 baseline 推进和冲突。若常规冲突、Review 和合并都依赖人工点击，ClickVibe 无法成为无人值守交付系统；若无门禁地交给 Agent，又会把声明误当事实。

## Decision

Agent 获得完成范围内工作所需的编码、git 和 gh 工具，可自动解决可恢复冲突。ClickVibe 控制器在每个副作用后重新观察权威事实。项目或任务显式允许 auto-merge 且 exact HEAD、契约、Review、CI 和 GitHub 门禁全部满足时，控制器自动合并；否则停在 ready-for-merge 或明确暂停。release/deploy 不由单 PR merge 策略自动推出。

## Trade-offs and failure modes

自动化扩大误操作爆炸半径，因此必须以精确目标、branch protection、required checks、事件审计和写后回读限制。提示词不是安全边界；unknown、override 和不可验证证据一律 fail closed。
