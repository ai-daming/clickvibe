import React from 'react'
import { createPortal } from 'react-dom'
import { deriveDeliveryTimelineItem } from '../delivery-timeline.ts'
import type { WorkflowEvent } from '../domain.ts'
import { fmtTime } from '../domain.ts'
import { deliveryPublicationLabel } from '../runtime.ts'

export function DeliveryTimeline({
  events,
  onOpenLog,
}: {
  events: WorkflowEvent[]
  onOpenLog: (taskId: string) => void
}) {
  const [selected, setSelected] = React.useState<WorkflowEvent | null>(null)
  React.useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected])
  if (events.length === 0) return null
  const selectedItem = selected ? deriveDeliveryTimelineItem(selected) : null
  return (
    <>
      <div className="cv-timeline">
        <div className="cv-timeline-head">📜 交付流水 · 本地事件 / GitHub 评论</div>
        {[...events].reverse().map((event, index) => {
          const item = deriveDeliveryTimelineItem(event)
          return (
            <div key={`${event.at}-${index}`} className="cv-tl-row">
              <button type="button" className="cv-tl-open" onClick={() => setSelected(event)}>
                <span className={`cv-tl-kind cv-tl-kind-${event.kind}`}>{item.kindLabel}</span>
                <span className="cv-tl-time">{fmtTime(event.at)}</span>
                {event.hash ? <code className="cv-tl-hash">{event.hash}</code> : null}
                {item.summary ? <span className="cv-tl-summary">{item.summary}</span> : null}
                {event.kind === 'review' && event.verdict ? (
                  <span className={event.verdict.passed ? 'cv-tl-verdict cv-tl-pass' : 'cv-tl-verdict cv-tl-fail'}>
                    {event.verdict.passed ? '✅ 通过' : `❌ ${event.verdict.issues.length} 个问题`}
                  </span>
                ) : null}
                {event.note ? <span className="cv-tl-note">{event.note}</span> : null}
              </button>
              <Publication publication={event.publication} />
            </div>
          )
        })}
      </div>
      {selected && selectedItem
        ? createPortal(
            <div className="cv-audit-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
              <aside
                className="cv-audit-drawer"
                role="dialog"
                aria-modal="true"
                aria-label={`${selectedItem.kindLabel}流水详情`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="cv-audit-head">
                  <div>
                    <strong>{selectedItem.kindLabel}详情</strong>
                    <div className="cv-audit-muted">{fmtTime(selected.at)}</div>
                  </div>
                  <button
                    type="button"
                    className="cv-audit-close"
                    onClick={() => setSelected(null)}
                    aria-label="关闭详情"
                  >
                    ×
                  </button>
                </div>
                {selectedItem.summary ? <div className="cv-audit-summary">{selectedItem.summary}</div> : null}
                {selected.hash ? (
                  <div className="cv-audit-section">
                    <h4>锚定提交</h4>
                    <code>{selected.hash}</code>
                  </div>
                ) : null}
                {selectedItem.detail.kind === 'review' ? (
                  <div className="cv-audit-section">
                    <h4>当轮 Review 意见全文</h4>
                    {selectedItem.detail.issues.length > 0 ? (
                      <ol className="cv-audit-list">
                        {selectedItem.detail.issues.map((issue, index) => (
                          <li key={index}>{issue}</li>
                        ))}
                      </ol>
                    ) : (
                      <div className="cv-audit-muted">本轮无阻塞意见。</div>
                    )}
                  </div>
                ) : selectedItem.detail.kind === 'development' ? (
                  <>
                    <div className="cv-audit-section">
                      <h4>提交列表</h4>
                      {selectedItem.detail.commits.length > 0 ? (
                        <ul className="cv-audit-list cv-audit-commits">
                          {selectedItem.detail.commits.map((commit) => (
                            <li key={commit.hash}>
                              <code>{commit.hash}</code> {commit.subject}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="cv-audit-muted">旧事件未冻结提交列表。</div>
                      )}
                    </div>
                    <div className="cv-audit-section">
                      <h4>Diffstat</h4>
                      {selectedItem.detail.diffstat.length > 0 ? (
                        <ul className="cv-audit-list cv-audit-diffstat">
                          {selectedItem.detail.diffstat.map((file) => (
                            <li key={file.path}>
                              <span>{file.path}</span>
                              <code>
                                {file.insertions === null ? 'binary' : `+${file.insertions}/-${file.deletions}`}
                              </code>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="cv-audit-muted">旧事件未冻结 diffstat。</div>
                      )}
                    </div>
                    {selectedItem.detail.taskId ? (
                      <button
                        type="button"
                        className="cv-audit-log"
                        onClick={() => {
                          onOpenLog(selectedItem.detail.kind === 'development' ? selectedItem.detail.taskId! : '')
                          setSelected(null)
                        }}
                      >
                        打开该轮日志 · {selectedItem.detail.taskId}
                      </button>
                    ) : null}
                  </>
                ) : selected.kind === 'merge-override' ? (
                  <div className="cv-audit-section">
                    <h4>人工放行</h4>
                    <div>跳过:{(selected.skippedLabels ?? selected.skipped ?? []).join('、') || '未知门禁'}</div>
                    <div>操作者:@{selected.operator ?? '?'}</div>
                    <div>原因:{selected.reason ?? '?'}</div>
                  </div>
                ) : null}
                {selected.userContext ? (
                  <div className="cv-audit-section">
                    <h4>用户附加说明</h4>
                    <div>{selected.userContext}</div>
                  </div>
                ) : null}
                <div className="cv-audit-section">
                  <h4>GitHub 发布</h4>
                  <Publication publication={selected.publication} />
                </div>
              </aside>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function Publication({ publication }: { publication: WorkflowEvent['publication'] }) {
  if (publication?.status === 'posted') {
    return publication.url ? (
      <a className="cv-tl-public" href={publication.url} target="_blank" rel="noreferrer">
        {deliveryPublicationLabel(publication)}
      </a>
    ) : (
      <span className="cv-tl-public">{deliveryPublicationLabel(publication)}</span>
    )
  }
  if (publication?.status === 'failed') {
    return (
      <span className="cv-tl-publish-fail" title={publication.error}>
        {deliveryPublicationLabel(publication)}
      </span>
    )
  }
  return <span className="cv-tl-local">{deliveryPublicationLabel(publication)}</span>
}
