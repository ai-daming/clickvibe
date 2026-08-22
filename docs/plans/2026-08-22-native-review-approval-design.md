# GitHub 原生 Review Approve 设计

Review 的本地结论、事件和 `== Review Meta ==` 评论仍沿用现有流水，保持它们是主要审计记录。仅当解析后的结论为通过且 workflow 已关联 PR 时，在评论发布完成后追加 `gh pr review <PR URL> --approve --body LGTM`，让 GitHub PR 页面显示原生 Approved。

原生 approve 是独立的 best-effort 外显动作。未通过或没有 PR 时跳过；GitHub 因自审限制、权限或网络问题拒绝时吞掉错误，只写诊断日志，不回滚或覆盖已经落盘的 verdict、event 和评论结果。

测试分别覆盖通过时调用、未通过时保持中性、approve 抛错不向上传播，并在 Review 路由集成测试中确认成功流水实际发出原生 approve 命令。最终门禁为全量测试、类型检查、构建和 `git diff --check`。
