import type { PendingDevelopAuthorization } from '../agent-authorization.ts'
import { baselineDependencyHint, baselineOptionLabel } from '../dev-authorization.ts'

export function DevelopAuthorizationDialog({
  pending,
  onBaseline,
  onCancel,
  onConfirm,
}: {
  pending: PendingDevelopAuthorization | null
  onBaseline: (baseline: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!pending) return null
  const preview = pending.preview
  const dependencyHint = baselineDependencyHint(preview.baselineDependencyIssue)
  return (
    <div className="cv-auth-overlay" role="dialog" aria-modal="true" aria-label="开始开发授权预览">
      <div className="cv-auth-dialog">
        <div className="cv-auth-title">开始开发 · 授权预览</div>
        <div className="cv-auth-snapshot">
          <strong>{preview.title ?? '当前 Issue'}</strong>
          <span>更新时间: {preview.updatedAt || '未知'}</span>
          <span>评论: {preview.commentCount ?? 0} 条</span>
          <span>快照: {preview.digest.slice(0, 12)}</span>
        </div>
        <details className="cv-auth-advanced" open>
          <summary>高级：开发基线</summary>
          <label className="cv-auth-baseline">
            <span>开发基线</span>
            <select
              value={preview.baseline ?? 'origin/HEAD'}
              disabled={preview.baselineFrozen || pending.refreshing}
              onChange={(event) => onBaseline(event.target.value)}
            >
              {(preview.baselineOptions ?? ['origin/HEAD']).map((ref) => (
                <option key={ref} value={ref}>
                  {baselineOptionLabel(ref)}
                </option>
              ))}
            </select>
          </label>
          {preview.baselineFrozen ? (
            <div className="cv-auth-frozen">基线已定格：{preview.baselineRef ?? preview.baseline}</div>
          ) : null}
          {pending.refreshing ? <div className="cv-auth-note">正在刷新所选基线授权…</div> : null}
          {preview.baselineWarning ? <div className="cv-auth-warning">⚠ {preview.baselineWarning}</div> : null}
          {dependencyHint ? <div className="cv-auth-warning">⚠ {dependencyHint}</div> : null}
        </details>
        <div className="cv-auth-actions">
          <button className="cv-dev-link" onClick={onCancel} disabled={pending.refreshing}>
            取消
          </button>
          <button className="cv-dev-btn cv-dev-codex" onClick={onConfirm} disabled={pending.refreshing}>
            确认启动
          </button>
        </div>
      </div>
    </div>
  )
}
