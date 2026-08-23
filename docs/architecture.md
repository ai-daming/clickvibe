# ClickVibe 代码架构

宿主入口 `src/index.ts` 只负责插件注册、HTTP 路由入口和方法分发；业务实现按单向依赖组织：

1. `src/infra`：配置、持久化、git/shell、HTTP、进程与流编解码等基础适配器。
2. `src/github`：GitHub REST 读取、映射和写入适配器，只依赖 infra。
3. `src/agent`：Agent 命令、prompt、worktree 和任务监督，只依赖 github/infra。
4. `src/workflow`：开发、review、同步、合并和状态推导等 use case，可依赖所有下层。

`src/client` 是独立浏览器边界，只依赖自身模块和 DSH/React 客户端包，不导入宿主模块。层级与客户端边界由 `pnpm run check:layers` 检查。

## 纯逻辑与 I/O 分离

推导、映射、格式化必须是纯函数；相同输入必须得到相同输出。一切 shell、文件、网络、时钟、随机数和进程句柄访问都集中在 infra/github 适配层。

`src/workflow/state-view.ts` 是范本：它接收普通 `WorkflowFacts`，返回普通状态和下一动作，不读取 git/GitHub、不访问时钟，因此可以在无沙箱、无 fake shell 的条件下完整测试。调用侧先由适配器读取事实，再把事实交给纯函数。

新增或搬移函数时先回答：“这个函数是否触碰 I/O？”触碰则放入 infra/github 适配器；不触碰则放入对应领域的纯逻辑文件，并用纯逻辑测试固定行为。仅当原子性或性能确实要求组合时，函数才可显式接收依赖，由调用者注入真实实现或最小可编程替身。

## 文件规模

`pnpm run check:size` 统计 `src` 和 `tests` 的物理行数。500 行以内直接通过；500–800 行必须在例外清单解释；超过 800 行且没有既有契约测试例外时拒绝。生产代码不保留 issue #61 的临时例外。
