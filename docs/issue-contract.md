# ClickVibe Issue 证据契约：从问题到交付

> 配套 [product-blueprint.md](product-blueprint.md) §“自动化边界”与 [ADR-0003](architecture/decisions/0003-issue-architecture-gate.md)。目标：让 GitHub Issue 成为 challenge、grill、impl-gate、Coding 和 Review 共享的当前交付契约，同时不把评论、运行状态和历史证据混入契约定义。

## 证据分层

GitHub 是 Issue 身份、正文、关系、状态和评论的事实源，但这些事实具有不同语义：

1. **当前交付契约**：目标、验收标准、直接依赖、非目标和约束。
2. **问题与证据**：说明为什么需要这项工作，以及结论是已观察、推断还是待验证。
3. **设计准入信息**：架构影响等级和 Accepted 设计引用。
4. **验收事实**：Acceptance Criteria 的勾选状态和相应证据。
5. **历史证据**：challenge、grill、impl-gate、Coding 和 Review 的评论或关联产物。
6. **Provider 元数据**：title、state、labels、updatedAt 等 GitHub 原生事实。

评论保存历史，但不重新定义当前契约。评论中确认的新要求或决定必须写回 Issue body 的对应契约字段，之后才能被授权、Coding 和 Review 消费。

## 最小集合

所有可交付 Issue 必须包含：

```markdown
## 问题与证据
状态：已观察 | 推断 | 待验证
一句话说明问题及其证据来源。

## 目标
一句话说明最终要改变什么。

## 验收标准
- [ ] 一条可明确判断通过或不通过的行为
- [ ] [人工] 只能由用户确认的行为
- [ ] [外部] 需要外部系统或审批证明的行为

## 依赖
无
```

`问题与证据` 不能只写拟议方案。若状态为“推断”或“待验证”，后续流程可以进入 challenge 或补证据，但不能把推断冒充已观察事实。

这份最小集合允许创建 Issue，不等于已经允许 coding。进入 ready 队列前还必须完成架构影响判定；READY 也不等于用户已经授权修改、提交、发布或其他外部动作。

## 存量 Issue 兼容

本契约采用渐进切换，不批量改写既有 Issue：

- 新建 Issue 必须满足当前最小集合。
- 已存在且符合旧 ClickVibe 最小语义（目标、可判定验收、直接依赖）的 Issue 可以标记为 `legacy-compatible`，不会仅因缺少新章节而自动失效。
- `legacy-compatible` 只表示允许继续读取和按现有证据接受门禁检查；缺失的非目标、约束或其他新语义仍是 `unknown`，不得解释成“无”。门禁需要该事实而现有正文或 Accepted 设计不能明确回答时，仍须停止。
- 对存量 Issue 的评论、元数据修改和验收勾选不触发格式迁移。
- 存量 Issue 首次发生 `contractAffecting` 正文或依赖修改时，必须在同一预览中补齐当前最小集合；不得只改一条旧字段后继续冒充当前契约。
- 不自动批量迁移、不静默重写，也不因采用本规范解除任何既有正文冻结。需要修改冻结正文时仍须获得该 Issue 的单独授权。

`legacy-compatible` 是治理兼容状态，不是 canonicalization 版本，也不进入 contract fingerprint。

## 渐进补充字段

### 非目标

明确本次不做什么。可以在创建时省略，但省略表示 `unknown`，不表示“无”。没有非目标时显式写：

```markdown
## 非目标
无
```

### 约束

记录不可突破的产品、架构、安全或兼容性边界。可以在创建时省略，但省略表示 `unknown`，不表示“无”。

```markdown
## 约束
不得长期双写；不得改变公开 API。
```

### 架构影响

创建时可以是 `unknown`。进入实现门禁前必须明确为 L0、L1、L2 或 L3；L2/L3 必须引用已经接受的设计基线。

| 等级 | 判断 | 进入 coding 前的要求 |
|---|---|---|
| L0 | 文案、样式、局部纯逻辑 | 遵守现有架构，可进入实现门禁 |
| L1 | 单模块行为变化 | 写明数据来源、状态与失败路径 |
| L2 | 跨模块、API、缓存、Git/GitHub I/O | 先形成设计或 ADR，并绑定 Accepted baseline |
| L3 | 并发、持久化、权限、自动合并、共享状态 | 先定义事实源、不变量、原子边界、失败模式、迁移与回滚 |

无法确定等级时不得默认降级，标记 `architecture-review-required`。L2/L3 的设计应先通过设计接受，再由 impl-gate 针对精确 baseline 核验；设计接受和 READY 均不替代实现授权。

### 待决问题

记录会改变范围、风险或实现边界的未决选择。非空时进入 grill，不得把 Agent 建议当作用户决定。确认后的决定写回目标、验收标准、依赖、非目标或约束等唯一对应字段；评论只保存过程、理由和接受证据。

### 入口

记录特殊的运行、复现或验证命令。它帮助执行，但不属于交付契约。

## 验收标准

验收标准必须能明确判断“通过/不通过”：

- ✅ `- [ ] 重试 3 次后状态标记为 failed 且日志输出原因码`
- ❌ `- [ ] 功能正常` / `- [ ] 处理好各种情况`

每条验收可用前缀声明验证权：

| 前缀 | 谁可验证 | 例 |
|---|---|---|
| 缺省 | Agent 可在 Review 时验证 | `- [ ] 重试 3 次后状态标记为 failed` |
| `[人工]` | 只能由用户确认 | `- [ ] [人工] 逐步操作录入 50 条手感正常` |
| `[外部]` | 只能凭外部证据确认 | `- [ ] [外部] 发布审批已通过（附链接）` |

ClickVibe 应把条款描述和验证权解析为结构化语义。未知前缀、冲突格式或解析失败必须成为 `unknown`，不得降级为 Agent 可自动验证。Agent 完成声明、代码存在或测试通过不能替代人工或外部证据。

`[ ]` 与 `[x]` 表示验收事实，不属于契约定义。勾选状态变化不改变 contract fingerprint；条款描述或验证权变化会改变 fingerprint。

## 依赖

- 只记录直接前置依赖：A→B→C 只记 B 被 A 阻塞、C 被 B 阻塞，不冗余记录 C 被 A 阻塞。
- 优先使用 GitHub 原生 `Blocked by` 关系；正文 `依赖: Blocked by #NN` / `依赖: 无` 仅作兼容降级。
- 原生关系与正文同时存在但冲突时，依赖状态是 `unknown`，不得任选一边继续授权。
- 依赖对象的身份属于交付契约；依赖当前是否已完成是实时准入事实，不进入 contract fingerprint。

## Issue 变更影响

| 分类 | 变化 | 必须发生的后果 |
|---|---|---|
| `framingAffecting` | 问题被推翻或实质重述 | 旧 challenge 结论失效，暂停签发新授权 |
| `contractAffecting` | 目标、AC 描述或验证权、直接依赖、非目标、约束变化 | 重新计算 contract fingerprint，并重新判断授权、Coding 和 Review |
| `designAffecting` | 架构影响等级或 Accepted 设计引用变化 | 旧 impl-gate 回执和实现授权失效 |
| `acceptanceEvidence` | AC 勾选状态或验收证据变化 | 更新完成事实，不改变 contract fingerprint |
| `historyOnly` | 评论、进度、调查过程或理由 | 不改变当前契约 |
| `metadataOnly` | title、state、labels、updatedAt 等 | 默认不改变 contract fingerprint |

一次变更可以属于多个分类。无法可靠分类且较宽松解释可能保留无效授权或 Review 时，必须返回 `unknown` 并停止沿用旧结论。

问题证据不进入 contract fingerprint。若新的问题证据改变了实际交付目标，必须先重新 challenge，再把结论写入目标、验收标准、非目标或约束。

架构影响和 Accepted 设计引用不进入 contract fingerprint，但属于 `designAffecting`；它们通过 impl-gate receipt 与精确架构 baseline 管理失效，不另造 architecture fingerprint。

## 机器与下游约定

- challenge 读取问题、证据状态和受影响对象；实质 framing 变化后必须重跑。
- grill 读取目标、范围边界、约束和待决问题；确认的决定必须写回当前契约。
- impl-gate 绑定工作身份、精确代码 baseline、当前契约、固定约束和 Accepted 设计。
- Coding 只能消费通过门禁且获得单独授权的当前契约。
- Review 同时验证业务验收与架构契约，并绑定仓库权威 canonical contract fingerprint 和 exact PR head。
- fingerprint 的字段、规范化、序列化、算法和版本由核心契约设计定义，不由 Issue 写作规范或 gh-issue Skill 各自发明。
- 未知 schema/canonicalization 版本必须 fail closed，不能解释为空契约、成功或继续沿用旧 Review。
- 自动写动作执行后必须回读 GitHub 验证；失败保留原始错误证据，状态不得冒充成功。
