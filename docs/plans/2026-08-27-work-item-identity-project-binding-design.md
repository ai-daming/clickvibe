# #134 WorkItemIdentity 与 ProjectBinding L3 设计

> Status: Draft | Maintainer direction: clean break confirmed | Issue: [#134](https://github.com/ai-daming/clickvibe/issues/134) | Code baseline: `dc19103fa67bfbea60010038117f971f1e68d930` | Architecture baseline: `9f841f1bc93604e8d802e3776997016140840e47` | Required decision: [ADR-0009](../architecture/decisions/0009-v02-clean-break-local-state-and-config.md)

## 0. 结论

#134 不只是新增四个字符串类型。它要把当前同时承担身份职责的 `repoKey`、Issue URL、workflow key 和本地 path 拆开，并建立两个唯一回答：

- “这是哪个外部 Work Item”只由 `WorkItemIdentity(provider, instance, container, id)` 回答；
- “这台机器用哪个 Git clone 执行”只由 `ProjectBinding` 回答。

本设计选择 v0.2 clean break：v0.1 state 冷备份，新的空 v0.2 state 继续使用 `~/.clickvibe/state`；旧 Git worktree/branch 原样保留但不自动导入。它推翻了已发布基线中的 legacy event 迁移要求；本地文档与 GitHub Issue #132、#134、#136、#137 已作为一组协调提案同步，但在 ADR-0009 与本设计 PR 的 exact-SHA review 通过并合入前，本文仍是 Draft，禁止 Coding。

## 1. 范围

### 1.1 目标

1. 落地 provider-neutral `WorkItemIdentity`，并成为领域层唯一 Work Item 身份。
2. 落地机器本地 `ProjectBinding`，明确 provider container、clone-stable `repositoryId`、当前 path 与显式 primary remote。
3. 定义 canonical serialization、hash、持久化 key 和冲突校验。
4. 定义 v0.1 → v0.2 配置/state clean-break 升级的事实源、不变量、阶段、失败和回滚。
5. 为 #122、#131、#135 和 #136 提供稳定作用域，不提前实现这些 Issue。

### 1.2 非目标

- 不实现跨机器注册、心跳、远程下单、任务迁移或执行地选择。
- 不改变 GitHub rename 语义；需要改变 `container` 稳定性时另立 superseding ADR。
- 不实现 WorkItemContractSnapshot、三个访问平面或 v0.3 EventEnvelope。
- 不自动迁移、删除、reset、stash 或 push 旧 worktree/branch。
- 不把本地 `repositoryId`、`bindingId` 或 host identity 放进 WorkItemIdentity。
- 不保留 v0.1 active runtime 的 state/config 兼容解析器；该点必须先由 ADR-0009 生效。

## 2. 现状事实与问题

当前 `IssueWorkflow` 同时持有：

```ts
interface IssueWorkflow {
  key: string
  url: string
  repoKey: string
  worktree: string
  branch: string
  // task/review/delivery/events ...
}
```

仓库中约有 95 处 `repoKey` 使用、22 个 `issueKey(...)` 调用；`config.yaml` 使用未版本化的 `owner/repo -> localPath` 映射。当前 state path 又从 `repoKey + Issue URL number` 推导。结果是：

- URL、repoKey、workflow key 和 path 都在不同位置冒充身份；
- GitHub number 验证渗入 workflow/infra；
- 相同 remote 的不同 clone 无法形成独立本地作用域；
- path 移动会影响绑定，remote 相同又可能错误合并 clone；
- 新旧 key 并存时没有唯一冲突应答源。

Git/GitHub 仍是代码、worktree、refs、Issue、PR、Review 和 CI 的权威；ProjectBinding 只是机器本地配置，不能提升事实等级。

## 3. 已确认决策与取舍

| 决策 | 采用 | 拒绝及原因 |
|---|---|---|
| Work Item 权威 | v0.2 领域层只认 WorkItemIdentity | types-only facade 会让 repoKey 继续当第二身份源 |
| repositoryId 单位 | 一个真实 clone 一个 ID；其 worktree 共用 | remote 级 ID 会合并独立 clone；path 级 ID 会随移动漂移 |
| repositoryId 存储 | Git common-dir 的 `clickvibe/repository-id` | config-only 无法证明 path 指向原 clone；path/remote hash 不稳定或不隔离 |
| v0.1 state | 整体冷备份；新 state 仍为 `~/.clickvibe/state` | 永久兼容增加双 schema；直接删除不可恢复 |
| 多机器 | 同 container 可有多个 Binding；每台机器当前启用一个 | 当前实现 clone picker 或远程调度是无消费者设计 |
| config | 显式授权后一次性转 v0.2 schema | 永久兼容 `repos` 把 legacy 债务带回运行时 |
| primary remote | Binding 明确保存 | upstream/顺序自动猜测会把读写路由到不同 remote |
| Binding mismatch | fail-closed + explicit rebind | 自动改 config 或仓库 ID 会把错误绑定伪装为成功 |
| 升级触发 | detect → preview → authorize → apply → read-back | 启动时隐式升级越过用户授权；手工改文件易错 |
| 旧 worktree | 保留、不导入；碰撞时阻止新任务 | 自动导入无法恢复写凭证/Review basis；删除会丢真实代码 |

## 4. 权威与不变量

### 4.1 权威表

| 问题 | 唯一应答源 | 其他数据的角色 |
|---|---|---|
| 外部 Work Item 是谁 | Provider Adapter 产出的 WorkItemIdentity | URL/displayKey 是 locator/展示 |
| 本地 clone 是谁 | Git common-dir 中的 repositoryId 文件 | config 中的值是 expected pin |
| container 绑定哪个 clone | 当前机器 v0.2 config 的 ProjectBinding | localPath 是 locator，可变化 |
| primary remote 是谁 | ProjectBinding.primaryRemote | current upstream 只作观察，不自动覆盖 |
| worktree/branch/dirty/conflict | 本地 Git | state 只保存观察或关联线索 |
| Issue/PR/Review/CI | Provider（当前 GitHub） | state/cache 不能覆盖 Provider |
| v0.2 task/session/log | 新 `~/.clickvibe/state` | v0.1 冷备份不授权动作 |

### 4.2 强制不变量

1. 四元组全部是非空字符串；GitHub number 只在 GitHub Adapter 转为十进制字符串。
2. core 不从 URL 猜 provider、instance、container 或 id。
3. WorkItemIdentity 不含 host、path、remote、repositoryId、branch 或 run id。
4. 一个 Git common-dir 只有一个 repositoryId；主 checkout 与 linked worktree 必须读到同一值。
5. 不同 clone 即使 primary remote URL 相同，也不得共用 repositoryId。
6. 当前机器同一 container 最多一个 active Binding；系统层允许其他机器拥有不同 Binding。
7. config pin、common-dir repositoryId、bindingId 推导必须一致；不一致时所有 Git 写和 Provider 写 fail-closed。
8. primaryRemote 必须存在于目标 clone；不得因当前 branch upstream 改变而漂移。
9. preview 阶段零写入；authorization 只覆盖 preview 指纹绑定的精确升级计划。
10. v0.1 state 冷备份和 Git 现场不被自动删除；新 v0.2 runtime 不读取冷备份授权动作。
11. 既有 worktree/path/branch 冲突时拒绝创建或覆盖；dirty、conflicted、ahead 均保持原样。
12. unknown schema、损坏记录、缺失 identity 或部分升级不能解释成空状态或成功。

## 5. 核心契约

### 5.1 WorkItemIdentity

沿用 ADR-0006：

```ts
interface WorkItemIdentity {
  provider: string
  instance: string
  container: string
  id: string
}
```

Provider Adapter 负责 provider-specific normalization；core serializer 不自行 trim、lowercase 或解释字段。GitHub Adapter 至少保证：

- `provider = "github"`；
- `instance` 为规范化 host；
- `container` 使用 Adapter 返回的 canonical owner/repository 表达；
- `id` 为正整数的十进制字符串。

### 5.2 Canonical serialization 与 key

序列化输入固定为无空白 JSON array：

```json
["clickvibe.work-item-identity",1,"github","github.com","ai-daming/clickvibe","134"]
```

规则：

- UTF-8；
- 固定 array 顺序，不按对象键枚举；
- 四字段缺失、空串或非字符串直接拒绝；
- JSON escaping 负责换行、引号和反斜杠，不使用分隔符拼接；
- hash algorithm version 固定为 `sha256-v1`；
- durable key 为 `wi1_<sha256 bytes 的 base64url>`。

state root 使用：

```text
~/.clickvibe/state/work-items/<durable-key>/
```

根记录必须同时保存完整 WorkItemIdentity；读取时重算 key 并核对，避免 hash/path 被当作无需验证的身份。

### 5.3 Repository identity

真实位置通过以下命令获得，不得拼接字面量 `.git`：

```bash
git rev-parse --path-format=absolute --git-common-dir
```

repositoryId 文件：

```text
<git-common-dir>/clickvibe/repository-id
```

首次注册用 exclusive create 原子生成 `repo_<UUID>`；已存在时只读并验证格式，禁止覆盖。并发注册只能有一个创建者，其他调用读取赢家结果。路径移动不改变 ID；重新 clone 得到新的 common-dir 和新的 ID。

### 5.4 ProjectBinding 与 config

运行时契约沿用 core-contracts：

```ts
interface ProjectBinding {
  schemaVersion: 1
  bindingId: string
  container: {
    provider: string
    instance: string
    id: string
  }
  repository: {
    repositoryId: string
    localPath: string
    primaryRemote: string
  }
}
```

bindingId 对以下 canonical tuple 计算 `sha256-v1`：

```json
["clickvibe.project-binding",1,"github","github.com","ai-daming/clickvibe","repo_<UUID>"]
```

config v0.2 示例（这是第一版带版本的 config schema，因此从 `1` 开始；不与产品版本号绑定）：

```yaml
schemaVersion: 1
projectBindings:
  - schemaVersion: 1
    bindingId: pb1_<base64url-sha256>
    container:
      provider: github
      instance: github.com
      id: ai-daming/clickvibe
    repository:
      repositoryId: repo_<UUID>
      localPath: /Users/example/work/clickvibe
      primaryRemote: origin
```

config 中的 repositoryId 是 expected pin，不是 clone 身份源。启动和每次高风险动作前至少验证：path 是 Git repository、common-dir ID 匹配、primaryRemote 存在。缺少 Binding 时 Provider 只读展示仍可用，需要 worktree/Git 的动作不可用。

## 6. 数据流

### 6.1 Provider Work Item

```mermaid
flowchart LR
  raw[GitHub URL / REST item] --> adapter[GitHub Adapter 验证与规范化]
  adapter --> identity[WorkItemIdentity]
  identity --> key[canonical serialization + wi1 hash]
  key --> state[v0.2 state lookup]
  identity --> binding[按 container 查当前机器 Binding]
  binding --> git[验证 repositoryId + remote]
```

workflow、cache、authorization、diagnostic 和后续 access plane 只接收 identity/key，不自行解析 URL 或重造 repoKey。

### 6.2 多机器边界

同一 Work Item 在 Mac 与 Ubuntu 上得到相同四元组；两台机器各自拥有不同 repositoryId/bindingId。当前版本不引入 host registry。未来执行路由可使用 `hostId + bindingId`，但 hostId 不进入 WorkItemIdentity，也不改变本设计的 key。

## 7. v0.1 → v0.2 显式升级

全新安装没有 legacy config/state 时不进入升级状态机：通过同样的 Binding preview/authorization 创建 repositoryId、schema 1 config 和空 state。只有检测到未版本化 config、v0.1 state 或未完成 upgrade journal 时，才进入以下升级流程并阻止普通写操作。

### 7.1 原子边界

state rename、config replace 和多个 Git common-dir 写入无法组成单个文件系统原子事务。升级必须用位于 active state 之外的 journal：

```text
~/.clickvibe/upgrade-v0.2.json
```

journal 带 schemaVersion、plan fingerprint、授权标识、每阶段状态、目标/备份路径和原始错误。只有 journal 为 `verified` 且所有 read-back 通过时，普通 v0.2 runtime 才可写入。

### 7.2 状态机

```mermaid
stateDiagram-v2
  [*] --> detected
  detected --> previewed: 只读盘点 + 计划指纹
  previewed --> authorized: 用户确认精确计划
  authorized --> backed_up: config/state 备份
  backed_up --> repositories_bound: 原子创建/读取 repo IDs
  repositories_bound --> config_written: 写 v0.2 config
  config_written --> state_created: 创建新 ~/.clickvibe/state
  state_created --> verified: 逐项回读
  verified --> [*]
  backed_up --> failed
  repositories_bound --> failed
  config_written --> failed
  state_created --> failed
```

### 7.3 Preview 内容

preview 至少显示：

- code/architecture baseline SHA；
- 旧 config hash、目标 config 完整内容和备份路径；
- 旧 state 路径、文件数/字节数、目标冷备份路径和新 state 路径；
- 每个 Binding 的 container、localPath、common-dir、repositoryId 现状、primaryRemote；
- live process/job 检查；
- `git worktree list` 中每个 worktree 的 path、branch、HEAD、dirty/conflict、ahead/behind；
- 会被写入、创建、rename 的每个路径；
- plan fingerprint 和明确不可逆项（本方案无自动删除）。

执行前重新读取 config hash、state identity 和 worktree inventory；与 preview 不同则授权失效，必须重新预览。

### 7.4 Apply 与 read-back

1. 再次确认没有 live task/job；旧 persisted `running` 只作为警告。
2. 写入 upgrade journal，并保存旧 config 备份。
3. 将旧 state rename 到唯一 cold-backup 目标；禁止覆盖。
4. 为每个已验证 repository 原子创建或读取 repositoryId。
5. 写临时 v0.2 config、设置权限、fsync/rename，再完整解析回读。
6. 创建新的空 `~/.clickvibe/state` 和 schema marker。
7. 验证 config pin/common-dir ID、primaryRemote、新 state schema 和 cold backup 可读。
8. journal 标记 `verified`；此后才允许普通写操作。

升级不删除旧 config backup、cold state backup、worktree、branch 或 remote ref。

### 7.5 失败与恢复

| 失败 | 系统状态 | 恢复 |
|---|---|---|
| preview 前配置/仓库无效 | 零写入 | 修复事实后重新 preview |
| 授权后 config/state 已变化 | 零业务写入 | 授权失效，重新 preview |
| state backup rename 失败 | 旧运行态不变 | 保留错误，停止 |
| 部分 repo ID 已创建 | 旧 state 已备份，ID sidecar 可存在 | journal 记录；重试读取同一 ID，不覆盖 |
| v0.2 config 写失败 | 不进入普通 runtime | 从 config backup 回滚；按 journal 恢复旧 state 路径或继续 |
| 新 state 创建/验证失败 | cold backup 保留 | 删除仅限本次创建且经 journal 证明的空/无效新目录，再恢复或重试 |
| read-back 不一致 | fail-closed | 不猜测成功；人工选择 resume/rollback |
| repositoryId mismatch | Binding 不可写 | 显式 rebind，新 preview/authorization |
| worktree dirty/conflicted/ahead | Git 现场原样保留 | 不阻塞升级，但阻止冲突的新任务，逐个处理 |

回滚不会删除已成功创建的 repositoryId sidecar；它没有授予动作的能力，后续注册可复用。回滚必须恢复旧 config 与旧 state 路径的配对，不能产生两个 active state。

## 8. 旧 worktree 与新任务

v0.2 启动时从 Git 实时读取 worktree/branch，而不是从 cold state 推断。若目标 Issue 的默认 worktree path、branch 或 Git branch 已存在：

- 展示实际 path、branch、HEAD 和 dirty/conflict/ahead 状态；
- 禁止覆盖、reset、stash、删除、自动 push 或自动关联为当前 workflow；
- 返回 `existing-unmanaged-worktree`（命名可在实现中确定）的明确阻断；
- “采用”旧现场属于新的显式动作，必须重新观察 Issue/PR/HEAD、建立新 v0.2 workflow，并让旧 Review/授权失效。本 Issue 不实现采用动作。

## 9. 安全与运维要求

- `config.yaml` 和 upgrade journal 权限不得放宽；repositoryId 不是 secret，但仍禁止通过不受控 symlink 写出 common-dir。
- 所有路径来自 Git/config 验证结果，不拼接未验证 shell 字符串。
- primaryRemote 是显式名字；写动作仍需各自授权和远端回读，Binding 验证不授予 push/merge 权限。
- 原始升级错误写入 journal/diagnostic；分类不能覆盖错误文本、动作和目标。
- 普通启动检测到旧 schema、未完成 journal 或 Binding mismatch 时必须可解释地拒绝写，而不是显示为空项目。

## 10. TDD 与验证矩阵

### 10.1 纯逻辑 RED

- WorkItemIdentity 四字段缺失、空串、非字符串拒绝。
- GitHub Adapter 的数字边界与 provider-neutral core 分离。
- canonical JSON 对引号、反斜杠、换行和字段边界无碰撞。
- 相同 identity 得到相同 `wi1` key；任一字段变化 key 变化。
- bindingId 对 path/primaryRemote 变化保持稳定，对 repositoryId/container 变化失效。
- config pin/common-dir ID/remote 校验返回明确 unknown/error，不返回 false success。

### 10.2 真实 Git 集成 RED

使用临时 HOME 和真实 Git repository，不引入 mock library：

- 主 checkout 与 linked worktree 读取同一 repositoryId；
- 两个相同 remote 的独立 clone 得到不同 ID；
- repository 目录移动后 ID 不变；
- 并发首次注册只产生一个 ID；
- 已存在无效/不一致 ID fail-closed；
- 显式 primaryRemote 缺失时 Binding 不可写；
- dirty/conflicted/ahead worktree 在 preview/apply 后字节、HEAD、refs 不变。

### 10.3 升级集成 RED

- preview 对 config、state、common-dir、worktree 零写入；
- plan fingerprint 绑定全部目标，任一事实变化使授权失效；
- 成功升级生成 config backup、cold state backup、新同路径 state 和 verified journal；
- 每个 apply 阶段注入真实文件系统失败，证明可重试或可回滚；
- 旧 config/state 不被 v0.2 active runtime 兼容读取；
- 未完成 journal、未知 schema、live task、ID mismatch 均阻止写；
- 备份目标重名不覆盖；cold backup 永不自动删除；
- 既有 worktree/branch 不被导入或清理，新任务碰撞时明确拒绝。

### 10.4 工程门禁

实现 PR 必须通过：

```bash
pnpm run typecheck
pnpm run build
pnpm test
pnpm run coverage
pnpm run lint
pnpm run check:size
pnpm run check:layers
pnpm run check:state-writes
```

覆盖率保持 statements/lines/branches/functions 全部满足仓库阈值；Review 绑定实现 PR exact head 与本设计合入后的 baseline SHA。

## 11. 实施切片与门禁

### Slice 0：架构生效（本设计 PR）

- 审查 ADR-0009；
- 若接受，同步 roadmap、canonical-domain-model、core-contracts、observability、#136 和 #137；
- 更新 #134 的架构影响等级、baseline SHA、约束和验收；
- 合入后记录 exact architecture baseline SHA。

### Slice 1：纯身份与 Binding 契约

- 先写 canonicalization/hash/config validation RED；
- 最小实现 WorkItemIdentity、repositoryId、ProjectBinding 纯契约与 infra adapter；
- 不混入三个访问平面。

### Slice 2：显式升级器与 state cutover

- 先写 preview/apply/recovery 和真实 Git/文件系统 RED；
- 实现 journal、备份、config 转换、新 state 创建和 read-back；
- 保留 worktree collision guard，不实现旧现场采用。

Slice 1/2 是否拆为两个实现 PR，由设计 PR Review 根据实际 diff 与迁移原子边界决定；不得把设计变更和功能实现放进同一 PR。

## 12. 完成标准

本文可从 Draft 进入 implementation-ready 的前提是：

1. ADR-0009 被明确 Accepted，且所有 Required Baseline Changes 同步合入；或维护者撤回 clean-break 决策，本文按 ADR-0006 重写迁移部分。
2. #134 body 明确 L3、Accepted baseline SHA、事实源、不变量、迁移和回滚入口。
3. Review 证明 WorkItemIdentity/ProjectBinding 没有泄漏 GitHub 专属响应类型或 host identity。
4. 升级协议对每个写目标有 preview、authorization、journal、read-back 和恢复路径。
5. 旧 worktree/branch 的保留边界与碰撞阻断有真实 Git 测试。

在以上条件满足前，#134 仍是设计阶段，不得开始 Coding。
