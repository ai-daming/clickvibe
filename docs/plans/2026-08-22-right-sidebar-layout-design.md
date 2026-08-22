# ClickVibe 右侧占位面板设计

## 目标与边界

ClickVibe 从 `shell.overlay` 中覆盖内容的 fixed 浮层改为 better-sidebar 式 layout push。展开时 DSH `#root` 给右侧面板留出等宽空间，conversation 内的消息区和输入框随根布局一起收缩。桌面默认取 viewport 的约 25%，支持拖动左边界；小于 768px 时布局变量为 0，ClickVibe 使用完整 viewport 宽度接管屏幕。

本次不修改 DSH 包、不接管原生 details，也不持久化用户拖动宽度。宽度在本次页面生命周期内保留，重新加载恢复默认比例。

## 结构与测量

插件仍注册 `shell.overlay`，但该 slot 只提供与插件开合一致的生命周期锚点。组件在 layout effect 中创建 body portal host；`#root` 通过插件 class、宽度变量和 `width + margin-right` 同步让位。ClickVibe 的 push 与 better-sidebar 的 `--dsh-sidebar-width` 相加，两个桌面右栏同时展开时依次占位，不互相覆盖。

右侧单面板不需要 better-sidebar 为底部面板准备的主列 `ResizeObserver`：`#root` 收窄后，宿主唯一的 `minmax(0,1fr)` 中心列会自然收缩。插件只监听 viewport resize 来切换 768px 断点和钳制宽度，避免“观察被自己挤压的主列”形成反馈循环。卸载时删除 portal、class 和 CSS 变量，完整恢复宿主布局。

## 响应式、交互与验证

桌面拖动柄使用 Pointer Events 和 pointer capture，宽度限制在 `[280px, viewport]`；pointer move 通过 rAF 直接写 portal 和 CSS 变量，pointer up 才提交 React 状态。移动端不渲染拖动柄并使用 frame 全宽。纯几何函数覆盖默认比例、拖动边界、768px 切换和“移动端不挤压”；交付前运行 typecheck、build、全部单元/集成测试，并在实际 DSH 页面分别检查桌面展开、拖动、关闭和手机 viewport。
