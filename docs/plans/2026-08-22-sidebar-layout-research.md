# 布局改造(#12)参考实现深挖:DSH-better-sidebar 机制与宿主结构

> 2026-08-22。为 issue #12(better-sidebar 式右侧占位展开)写的实现前调研。
> 结论先行:**参考实现找到了,就是同为 DSH 插件的 `omdsh-dev/DSH-better-sidebar`**,机制比想象的简单且成熟,ClickVibe 只需移植其中的"布局挤压"部分,无需移植它的双面板/工作台。

## 1. 参考实现定位

`omdsh-dev/DSH-better-sidebar`(main 分支,当前 v0.13.x)——一个完整的 DSH 客户端插件,给 DSH 加右侧侧栏(VSCode 式双面板)。**它就是 issue #12 说的 better-sidebar,而且本身就是 DSH 插件**,与我们同生态、同 slot 体系,参考价值最高。

关键文件(已拉到 /tmp/bsb/):
- `src/client/layout.css`(94 行)—— **布局挤压的全部机制**
- `src/client/Sidebar.tsx`(1285 行)—— 测量/拖拽/窄屏渲染
- `docs/plans/2026-08-12-mobile-layout-design.md` —— 移动端(<768px)设计文档,**含实施偏差教训**

## 2. 核心机制:布局挤压(layout.css)

桌面(≥768px)面板打开时,让**整个应用壳给面板让位**,而不是面板浮在壳上:

```css
#root {
  margin-right: var(--dsh-sidebar-width, 0px);
  width: calc(100% - var(--dsh-sidebar-width, 0px));
  transition:
    margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    width var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
```

要点:
1. **写 `<html>` 上的 CSS 变量**,壳的 margin 消费它。变量在收起时是 0px → 无挤压;展开时 = 面板宽 → 壳让位。
2. `width: calc(100% - var(...))` 而非裸 margin:某些 shell(DSH Desktop, issues#208)把 #root 设成 `width:100%`,裸 margin 会加性溢出视口;calc 保证盒子恒为"100% 减让位量"。
3. **动画与宿主同节奏**:过渡时长/缓动用 DSH 主题自带 token(`--ds-transition-duration-slow` / `--ds-ease-in-out`),面板展开和壳收缩"锁步"。
4. `body[data-dsh-sidebar-dragging]` 时关过渡(拖拽跟手),`prefers-reduced-motion: reduce` 时全关。
5. 只挤中心列(底部面板场景):`#root [data-dsh-frame] > [data-pane="conversation"]` + `:has(> [data-slot="conversation"])` 双选择器锚定 AppFrame 中心列,`margin-bottom` 让底部面板出现时中心内容(输入框)上移。**这是底部面板才需要的;ClickVibe 只有右侧面板,可忽略**。

## 3. 测量主列(Sidebar.tsx,底部面板场景)

- 定位锚点:**`#root [data-slot="conversation"]` 的 parentElement 就是中心列**,不依赖哈希类名/nth-child。
- **ResizeObserver 观察中心列**,变化才 setState(纯高度变化不触发,保持 prev 引用)。
- **三路兜底定位**(boot swap / HMR 重渲染都会换 DOM 节点):
  - `MutationObserver` 观察 #root 的 subtree(rAF 节流);
  - 观察 `<html>` 的 style 属性(布局变量重写时重定位);
  - 1500ms 无条件 interval 兜底(issue #248)。
- **拖拽期间暂停测量**(每帧拖拽都在改中心列宽,立刻 setState 会重引入拖拽卡顿),pointerup commit 前先补量一次。

同样,这是底部面板需求;#12 只有右面板,连中心列测量都不需要——**需要测量的只有被挤压后的壳是否工作,没有第二面板要跟随**。

## 4. 宽度拖拽(applies 到 #12 验收标准 2)

- `pointer capture` + `requestAnimationFrame` 节流(每帧至多一次写),**拖拽中直接写 DOM**(面板 width + 布局变量),不 round-trip store → 不触发 React 重渲染 → 不卡。
- pointerup 时把最终值提交 store(clamp + 持久化),**up 位置优先于最后一个 move**(快速甩动的 move 尾帧可能过期,issue #247)。
- clamp:宽度钳制 `[PANEL_MIN, window.innerWidth]`。
- 拖拽条只渲染在桌面(窄屏无物可拖)。
- 关键心得:**"拖拽中写 DOM、松手才落 store"** 是滑动流畅的全部秘密——ClickVibe 宽度可调照抄即可。

## 5. 移动端(<768px,文档 + 代码)

`docs/plans/2026-08-12-mobile-layout-design.md`,要点(适用于 #12 验收标准 3):

1. **断点 768,刻意不对齐宿主 1024**(`SIDEBAR_AUTO_COLLAPSE`):只有手机/竖屏平板进移动布局,1024px 小笔记本/分屏保留桌面双列。
2. **窄屏 = 全宽抽屉 100vw**,布局变量恒 0(**抽屉悬浮、不挤压壳**),宽度拖拽条/底部面板全不渲染。
3. `useNarrowViewport()` hook:读 `window.innerWidth` + resize(rAF 节流),**不用 matchMedia**(jsdom 未实现)。
4. 移动端优化:新会话默认收起、文件打开自动展开、`visualViewport` 键盘 inset(面板 bottom 抬升避让输入法)。
5. **实施偏差记录教训**:v1 曾做"单面板内上下堆叠两个工作台"被用户推翻 → v2 改为"底部标签直接并入右侧栏"。教训:**移动端优先保证简单直接,别急着造新布局结构**。
6. CSS 侧配对 `@media (max-width: 767px)`(767 ≡ <768),与 JS hook 注释互指。

## 6. 宿主(DSH web)结构事实——验证锚点

改的是 ClickVibe 这个 DSH 插件,必须确认宿主 DOM 与参考实现声称的一致。已读 `deepseek-harness/apps/web` + `packages/client/ui-layout`:

**AppFrame(三列 grid)**:`packages/client/ui-layout/src/client/AppFrame.tsx`

```tsx
<div className={css.frame}
     style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0,1fr) ${cols.details}px` }}
     data-sidebar-collapsed={...} data-details-collapsed={...} data-dragging={...}>
  <div className={css.sidebarCol}>{renderSlot('sidebar')}</div>
  <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>   {/* minmax(0,1fr) 弹性列 */}
  <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
  <div className={css.overlayLayer} data-shell-overlay>{renderSlot('shell.overlay')}</div>
  <DragHandle side="sidebar" ... /> <DragHandle side="details" ... />
</div>
```

- **中心列是 `minmax(0, 1fr)`** —— 唯一弹性列。壳被挤窄时,回收的宽度正好全落在中心列(会话输出 + 输入框都在 conversation slot)→ "主内容让位、dsh 输入框不打架"在宿主侧天然成立。
- **`shell.overlay` 渲染在 AppFrame 的 overlayLayer 里**(`position:absolute; inset:0; z-index:20; pointer-events:none`,子级 `auto`)。这解释了 ClickVibe 现在的 `position:fixed + zIndex:9000` 是"浮层套浮层",与 `#root` 让位互不相关。
- **`[data-slot="conversation"]` 确认存在**:`packages/client/ui-renderer/src/client/scoped-slots.tsx` 中 slot host 渲染 `<div data-slot={slotKey}>` 包装器(scoped-slots.tsx:676),与 better-sidebar 的定位锚点一致。
- 注意:宿主自身**没有** `data-pane="conversation"` 或 `--dsh-sidebar-*` 变量(那是 better-sidebar 插件私有的),且当前搜索源码里 **没有** `data-dsh-frame` 属性——better-sidebar 的双选择器里,`[data-dsh-frame]` 那条在宿主改名时失效,靠 `:has(> [data-slot="conversation"])` 兜底。**ClickVibe 应只依赖 `[data-slot="conversation"]`,不依赖 data-dsh-frame/data-pane**。

**宿主自身让步链**(`columns.ts`,与 #12 交集不大但要知晓):
`center>=640` 优先 → 挤 details(300→自关)→ 最后 center 吸收全部 deficit;sidebar 永不让步。**风险**:壳宽被 ClickVibe 挤窄后,宿主可能在窄视口主动关 details 列——行为可接受,但 #12 的"让位"应与宿主让步链叠加而非对抗(改 #root margin 天然叠加,不动宿主 grid)。

## 7. #12 落地设计建议(基于以上)

ClickVibe 需要做的是 **"右面板占位挤压"子集**,比 better-sidebar 简单得多:

1. **CSS 变量承载挤压**:面板 open 时写 `<html>` 的 `--cv-sidebar-width`(用 ClickVibe 自己的前缀,**不要复用 `--dsh-sidebar-width`,避免和 better-sidebar 同装打架**);注入 `#root { margin-right: var(--cv-sidebar-width, 0); width: calc(100% - var(--cv-sidebar-width, 0)); transition: ... }` 样式(与宿主同 token 同节奏,拖拽时关过渡)。
2. **面板本体**:保持 fixed 定位(右侧),宽度 = `--cv-sidebar-width`;桌面默认 25%(`window.innerWidth * 0.25`),clamp `[PANEL_MIN, innerWidth]`。
3. **拖拽条**:面板左缘 8px pointer-capture 条,**拖拽中直接写 DOM(面板宽 + CSS 变量),pointerup 才提交 React state**;拖动时 body 加 `data-cv-dragging` 关过渡。
4. **窄屏 <768px**:面板宽 100vw、`--cv-sidebar-width` 恒 0(抽屉悬浮不挤压),不渲染拖拽条;`useNarrowViewport()` 用 innerWidth + rAF,不用 matchMedia。
5. **不需要**:中心列 ResizeObserver、MutationObserver、底部面板、拐角——都是 better-sidebar 双面板场景的复杂度。

## 8. 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 变量名冲突 | 若 `--dsh-sidebar-width` 与 better-sidebar 同装,双写打架 | 用 `--cv-sidebar-width` 私有前缀 |
| 宿主版本漂移 | `data-dsh-frame`/`data-pane="conversation"` 宿主无此属性(已核实),未来改名 | 只依赖 `[data-slot="conversation"]`(scoped-slots 稳定) |
| 宿主让步链对抗 | 挤窄壳可能触发宿主自关 details | 改 #root margin 与宿主链天然叠加,不改宿主 grid |
| z-index 与 overlayLayer | 当前 ClickVibe 在 overlayLayer(z-index 20)里再 fixed+9000 | #12 改后仍可 fixed,#root 让位后无遮挡问题;z-index 9000 可保留但非必须 |
| 动画不同步 | 面板滑入与壳收缩若不同节奏 | 共用 `--ds-transition-duration-slow` / `--ds-ease-in-out` |

## 9. 参考链接

- 参考实现仓库:https://github.com/omdsh-dev/DSH-better-sidebar (`src/client/layout.css`, `src/client/Sidebar.tsx`, `docs/plans/2026-08-12-mobile-layout-design.md`)
- 宿主源码(本机 checkouts):`deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx`、`columns.ts`、`scoped-slots.tsx`