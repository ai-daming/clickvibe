/** Repository-level remote advance signal and safe-sync action. */
import React from 'react'
import type { RepositoryAdvanceSignal } from '../domain.ts'

export function RepositoryAdvanceBanner({
  signal,
  busy,
  onSync,
}: {
  signal: RepositoryAdvanceSignal | null
  busy: boolean
  onSync: () => void
}) {
  if (!signal || ((signal.mainBehind ?? 0) === 0 && (signal.checkoutBehind ?? 0) === 0)) return null
  return (
    <div className="cv-repo-advance">
      <div>
        {(signal.mainBehind ?? 0) > 0 ? (
          <div>
            远端 {signal.remoteRef} 领先本地 main {signal.mainBehind} · 上次 fetch{' '}
            {signal.fetchedAt === null ? '未知' : new Date(signal.fetchedAt).toLocaleString()}
          </div>
        ) : null}
        {signal.checkoutBranch && (signal.checkoutBehind ?? 0) > 0 ? (
          <div>
            当前分支 {signal.checkoutBranch} 落后 {signal.remoteRef} {signal.checkoutBehind}
          </div>
        ) : null}
      </div>
      <button className="cv-batch-btn" disabled={busy} onClick={onSync}>
        {busy ? '同步中…' : '安全同步'}
      </button>
    </div>
  )
}
