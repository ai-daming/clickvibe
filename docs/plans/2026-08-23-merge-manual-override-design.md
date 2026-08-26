# Issue #49：合并门禁「人工放行」兜底设计

> Status: Historical | Superseded policy: [ADR-0004](../architecture/decisions/0004-policy-controlled-autonomous-delivery.md)
>
> 本文记录 issue #49 当时的实现设计。其中“合并必须人点”不再是当前产品原则；当前规则是由项目/任务策略与全部事实门禁共同决定是否自动合并。人工 override 仍是独立、高风险且必须审计的例外能力。

## 目标与边界

ClickVibe 自身合并门禁(PR HEAD 与 review 结论哈希一致、验收契约快照存在/可读/未变更)拒绝合并时,面板在拒绝原因旁提供「仍要合并(人工放行)」兜底入口。人工放行只跳过 ClickVibe 自身门禁,不绕过 GitHub 侧保护(protected branch / required reviews 等);`gh pr merge` 失败时错误原样透传。未人工放行的拒绝行为与报错文案保持不变,「合并必须人点」的规则不变——放行本身就是一次人工点击加二次确认。

## 门禁建模与放行绑定

服务端把原先散落的哈希/契约前置校验统一为 `collectMergeGateFailures`,按历史报错优先级(哈希 → 契约缺失 → 不可读 → 已变更)收集全部失败项,每项带稳定 key(`review-hash` / `review-contract-missing` / `contract-unreadable` / `contract-changed`)。预览与执行共用同一收集函数;未请求放行时按首条失败生成与旧实现逐字相同的拒绝文案。与 issue #48 的同步等价免重审衔接:哈希门禁直接复用 `assertReviewHeadMatchesPr`——R 与最新 origin/main 的纯同步合并视为门禁通过,不进入可放行失败项;其拒绝文案跟随 #48 的新措辞(含「且不满足同步等价」)。

放行通过既有单次授权机制绑定:`AgentAuthorizationInput` 增加可选 `override { skipped, reason }`,计入授权摘要 SHA-256,篡改或重放即失效。授权路由在门禁失败且请求携带 `override: true` + 非空原因时,以**当时实际失败项**生成 skipped 集合;`/merge` 执行时重新收集门禁,失败项必须被授权的 skipped 完全覆盖才放行——确认后新增的门禁失败(如新推送提交导致哈希再次不一致)不被旧确认覆盖,需重新走放行流程。放行授权同样单次使用。

## 审计与时间线

放行先于 `gh pr merge` 写入 workflow 事件链,新增事件类型 `merge-override`,记录跳过项、放行原因、本机操作者(`os.userInfo().username`)与时间;即使随后合并失败,放行动作也可追溯。事件类型与 review 结论事件分离,放行不冒充 review 通过;面板时间线以红色「人工放行」徽标展示明细。放行不改变 GitHub 侧任何行为,分支保护拒绝合并时按原有路径报错。

## UI 与验证

入口有两个可见时机:合并尝试被门禁拒绝后(服务端返回门禁清单,面板在错误旁渲染入口与逐项失败明细);以及 review 已通过但结论/契约过期、面板停留在「重新 Review」或「无法读取契约」时。放行流程为独立二次确认:填写放行原因(必填,写入审计)→ 服务端重新弹预览并列出本次跳过的门禁项 → 用户逐项确认(每个门禁项单独确认框,任一取消即中止)→ 最终汇总预览确认 → 执行合并与清理。若确认时门禁已全部通过(此前拒绝基于过期数据),回退为正常合并预览。

测试覆盖:门禁拒绝返回门禁清单;放行授权绑定 skipped 与原因;拒绝 → 放行 → 合并成功且 `merge-override` 审计事件进入归档时间线;放行授权重放拒绝;确认后新增未覆盖门禁项时拒绝且不写审计、不调用 `gh pr merge`;`makeAuthorizationInput` 对未知门禁 key、空原因、布尔开关的边界;以及既有合并/门禁回归测试全部不变。最后执行 typecheck、全量测试和 build。
