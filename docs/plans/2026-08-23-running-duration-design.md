# Issue #87 运行计时呈现收敛设计

## 决策

运行计时统一由 `src/client/duration.ts` 的 `RunningDuration` 展示。Issue 详情、仓库列表和实时终端头都直接使用该组件；终端头通过 `compact` 仅隐藏说明文字，不改变 `HH:MM:SS` 格式。

纯格式化继续由 `src/client/runtime.ts` 的 `formatElapsed` 提供。host 侧因 bundle 边界保留 `src/infra/live-output.ts` 的纯函数副本，并由 `tests/runtime-contract.test.ts` 双向校验，避免协议两端漂移。

## 数据流与边界

调用方只传入任务开始时间。`RunningDuration` 负责读取当前时间并每秒刷新；调用方不再维护重复的计时 state 或 effect。完成态耗时仍由 `DeliveryDuration` 负责，不属于本次运行计时收敛范围。

## 验证

- 组件测试覆盖完整文案与终端紧凑文案。
- 架构契约测试锁定详情、列表、终端头均引用 `RunningDuration`。
- 跨 bundle 契约测试锁定 client/host 的 `formatElapsed` 对相同边界输入输出一致。
