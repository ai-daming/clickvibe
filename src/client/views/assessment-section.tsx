/** Advisory assessment controls; no dependency on workflow readiness. */
import React from 'react'
import {
  assessmentCall,
  currentAssessmentModel,
  discussAssessment,
  useAssessments,
  type AssessmentItem,
} from '../assessment.ts'
import { renderMarkdown } from '../format.tsx'
export function AssessmentControls({ url, item }: { url: string; item?: AssessmentItem }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const active = item?.phase === 'running' || item?.phase === 'queued'
  return (
    <div className="cv-assessment">
      <div className="cv-assessment-actions">
        <button
          className="cv-row-action cv-assessment-action"
          disabled={busy || active}
          onClick={() =>
            void run(async () =>
              assessmentCall({
                action:
                  item?.phase === 'failed' || item?.phase === 'interrupted' || item?.phase === 'cancelled'
                    ? 'retry'
                    : 'evaluate',
                urls: [url],
                model: await currentAssessmentModel(),
              }),
            )
          }
        >
          评估
        </button>
        <span>{item?.label ?? '未评估'}</span>
        {active ? (
          <button
            className="cv-row-action cv-assessment-action"
            disabled={busy}
            onClick={() => void run(() => assessmentCall({ action: 'cancel', id: item?.id }))}
          >
            取消评估
          </button>
        ) : null}
        {item?.report ? (
          <button className="cv-row-action cv-assessment-action" onClick={() => setOpen(!open)}>
            {open ? '收起报告' : '查看报告'}
          </button>
        ) : null}
        {item?.discussion ? (
          <button
            className="cv-row-action cv-assessment-action"
            disabled={busy}
            onClick={() => void run(() => discussAssessment(item))}
          >
            继续讨论
          </button>
        ) : null}
      </div>
      {item?.publication && item.phase === 'completed' && item.publication.status !== 'published' ? (
        <div className="cv-hint">
          报告已保存本地 ·{' '}
          {item.publication.error ??
            (item.publication.status === 'unknown' ? 'GitHub 保存待核实' : '等待保存到 GitHub')}
          <button
            className="cv-row-action cv-assessment-action"
            disabled={busy}
            onClick={() => void run(() => assessmentCall({ action: 'publish', id: item.id }))}
          >
            核对保存
          </button>
        </div>
      ) : null}
      {error || item?.error ? <div className="cv-error">{error || item?.error}</div> : null}
      {open && item?.report ? <div className="cv-md">{renderMarkdown(item.report.text)}</div> : null}
    </div>
  )
}
export function AssessmentSection({ url }: { url: string }) {
  const { items, error } = useAssessments([url])
  return (
    <section className="cv-section">
      <strong>开发准备评估</strong>
      <AssessmentControls url={url} item={items[0]} />
      {error ? <div className="cv-error">{error}</div> : null}
    </section>
  )
}
export function AssessmentBatch({ urls, repoKey }: { urls: string[]; repoKey: string }) {
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  React.useEffect(() => {
    let live = true
    void assessmentCall<{ setting: { enabled: boolean } | null }>({ action: 'settings', repoKey })
      .then((result) => {
        if (live) setEnabled(result.setting?.enabled ?? false)
      })
      .catch((reason) => {
        if (live) setError(String(reason))
      })
    return () => {
      live = false
    }
  }, [repoKey])
  return (
    <span className="cv-assessment-actions">
      <button
        className="cv-batch-btn cv-batch-secondary"
        disabled={busy || !urls.length}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            await assessmentCall({ action: 'evaluate', urls, model: await currentAssessmentModel() })
          } catch (reason) {
            setError(String(reason))
          } finally {
            setBusy(false)
          }
        }}
      >
        批量评估 ({urls.length})
      </button>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={async (event) => {
            const next = event.target.checked
            setBusy(true)
            try {
              await assessmentCall({
                action: 'configure',
                repoKey,
                enabled: next,
                ...(next ? { model: await currentAssessmentModel() } : {}),
              })
              setEnabled(next)
            } catch (reason) {
              setError(String(reason))
            } finally {
              setBusy(false)
            }
          }}
        />
        自动评估
      </label>
      {error ? <span className="cv-error">{error}</span> : null}
    </span>
  )
}
export function AssessmentMilestone({ repoKey, title }: { repoKey: string; title: string }) {
  const [urls, setUrls] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [showResults, setShowResults] = React.useState(false)
  const results = useAssessments(showResults ? (urls ?? []) : [])
  React.useEffect(() => {
    let live = true
    void assessmentCall<{ urls: string[] }>({ action: 'targets', repoKey, milestone: title })
      .then((result) => {
        if (live) setUrls(result.urls)
      })
      .catch((reason) => {
        if (live) setError(String(reason))
      })
    return () => {
      live = false
    }
  }, [repoKey, title])
  return (
    <div>
      <button
        className="cv-row-action cv-assessment-action"
        disabled={!urls?.length || busy}
        title="包含该里程碑已关闭的 Issue，不受页面筛选影响"
        onClick={async () => {
          setBusy(true)
          try {
            await assessmentCall({ action: 'evaluate', urls, model: await currentAssessmentModel() })
            setShowResults(true)
          } catch (reason) {
            setError(String(reason))
          } finally {
            setBusy(false)
          }
        }}
      >
        全部评估{urls ? ` (${urls.length})` : ''}
      </button>
      {error || results.error ? <span className="cv-error">{error || results.error}</span> : null}
      {showResults ? (
        <details open>
          <summary>逐项评估进度</summary>
          {results.items.map((item) => (
            <div key={item.url}>
              <a href={item.url} target="_blank" rel="noreferrer">
                #{item.url.split('/').at(-1)}
              </a>
              <AssessmentControls url={item.url} item={item} />
            </div>
          ))}
        </details>
      ) : null}
    </div>
  )
}
