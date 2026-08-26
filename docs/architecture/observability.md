# 可观测性与复盘

> Status: Accepted | Parent: [当前有效架构](../architecture.md)

可观测性不是面板上“有日志”就完成。ClickVibe 必须能够回答：某个 Issue 在什么事实下、按哪版架构、由谁决定了什么、执行了什么、结果是否被重新观察到。

## 三类记录

| 记录 | 内容 | 用途 |
|---|---|---|
| Task log | Agent 原始结构化输出、命令、stdout/stderr、exit、token/时长 | 看施工过程和复现失败 |
| Workflow event | observe/decision/action/result、HEAD、契约指纹、actor、task generation | 重建 Issue 生命周期 |
| Diagnostic event | 原始异常、stack、fingerprint、retry、rate limit、runtime instance | 解释控制器和基础设施故障 |

## 统一事件信封

新事件使用[核心数据契约](core-contracts.md)定义的 `EventEnvelope<type, payload>`。下例只展示外形；字段语义不在本文另起一套定义：

```json
{
  "schemaVersion": 1,
  "eventId": "...",
  "type": "review.completed",
  "workflow": {
    "workItem": {
      "provider": "github",
      "instance": "github.com",
      "container": "owner/repo",
      "id": "123"
    }
  },
  "sequence": 42,
  "generation": 4,
  "correlationId": "...",
  "causationId": "...",
  "occurredAt": "...",
  "actor": "controller|coding-agent|review-agent|runtime-observer|protocol-observer|user",
  "basis": {
    "workflow": {
      "workItem": {
        "provider": "github",
        "instance": "github.com",
        "container": "owner/repo",
        "id": "123"
      }
    },
    "contract": {"fingerprint": "..."},
    "architecture": {"revision": "..."},
    "baseline": {"ref": "refs/remotes/origin/main", "sha": "..."},
    "head": {"sha": "..."}
  },
  "payload": {"conclusionId": "...", "verdict": "pass"}
}
```

这是目标契约。v0.2 先让新写入满足它；旧日志按复盘价值决定迁移、兼容读取、归档或备份后废弃，不为无价值旧格式建立永久兼容层。

## 复盘必须回答的问题

1. 当时观察到了哪些 Git/GitHub/任务事实？
2. 哪个函数或策略选择了下一动作？
3. Coding/Review Agent 获得了哪些 Issue 与架构上下文？
4. Agent 声明完成后，控制器重新验证了什么？
5. 错误的原文、stack、目标和重试是否保留？
6. 自动化为何继续、暂停或合并？
7. 后来的代码、契约或架构变化是否使旧证据过期？

## Observer 事件链

运行时介入至少追加以下不可变事件，不允许只在面板显示一段摘要：

1. `loop.health-evaluated`：策略版本、轮次、母题、进展指标和判定。
2. `observer.triggered`：触发规则、evidenceHash 和冻结的 DeliveryBasis。
3. `observer.started`：DSH session/task id、模型/Agent 配置、权限和预算。
4. `observer.completed`：结构化判决、唯一指令、验证证据、usage 和原始输出位置。
5. `observer.directive-applied`：哪个 workflow generation 接受了该指令。
6. `observer.post-reviewed`：验证轮是否消除了原母题，或为何升级给人。

`session.prompt()` 被宿主接受只表示任务入队，不能记录成 Observer 完成。完成必须来自目标会话对应 turn 的终态及持久化 assistant 输出。迟到、超时、取消、结构化解析失败和模型错误都要保留原始错误，并产生明确的 `unknown` 或 `human-required` 结果。

## 保留与隐私

- 小文件按任务 generation 使用不可变 JSONL；活动 diagnostics 有上限和轮转。
- 面板展示可以折叠，但原始错误不可被分类文案覆盖。
- prompt、命令和日志可能包含仓库内容或凭据痕迹；落盘前应执行字段级脱敏，禁止记录 token、credential helper 输出和私钥。
- GitHub 评论只发布适合协作的摘要；完整本地诊断不默认上传。
