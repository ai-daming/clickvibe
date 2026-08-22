# GitHub REST 读取与缓存设计

## 范围

只替换 ClickVibe 的 GitHub 读取层。Issue/PR 列表、详情、评论、review、timeline、依赖扫描、Issue 状态和 PR 状态均通过 `gh api` REST 获取；评论、关闭 Issue、合并 PR 等写操作保持原命令与门禁。

## 数据与缓存

REST 响应在服务端映射回现有面板字段。PR `reviewDecision` 按 reviewer 聚合最新有效 review：任一最新决定为 `CHANGES_REQUESTED` 时返回该状态，否则存在批准则为 `APPROVED`。

仓库 issues/pulls 聚合使用与现有刷新配置一致的短 TTL，并合并并发请求。单 Issue/PR 详情按资源缓存；仓库聚合提供的 `updated_at` 与缓存版本一致时直接复用完整详情，不再访问 GitHub。尚无版本提示时使用短 TTL。手动刷新、开发/Review 阶段启动和合并契约校验可绕过缓存。评论、PR 合并和 Issue 关闭成功后主动失效相关详情与仓库聚合，避免写后读旧状态。

## 限流与失败

所有 REST 响应读取 HTTP headers。遇到 `403/429`、`X-RateLimit-Remaining: 0` 或 secondary rate limit 时，优先使用 `Retry-After`，否则使用 `X-RateLimit-Reset` 建立进程内熔断。恢复前所有后续读取零请求失败，并统一返回 `GitHub 额度已用完,约 HH:MM 恢复`；面板直接显示该文案并保留已有数据。

## 验证

测试覆盖 REST 字段等效、latest review 推导、详情与聚合缓存命中、强制刷新、限流恢复时间、跨路由熔断、分页、spill 输出及最新 main 的 Review 契约/合并门禁。
