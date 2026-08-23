import React from 'react'
import { type Workflow, apiCall } from '../domain.ts'
import { expectedDevelopSnapshot } from '../dev-authorization.ts'
import type { GhIssue } from './issue-view.tsx'
import { AUTO_RUN_PAUSE_LABEL, autoRunDefaults, synchronizeAutoRunDraft, unresolvedFindingCount } from '../auto-run.ts'

export interface AutoRunFormProps {
  url: string
  issue: GhIssue
  workflow: Workflow | null
  compact?: boolean
  onStarted: () => void | Promise<void>
}

export function AutoRunForm({ url, issue, workflow, compact = false, onStarted }: AutoRunFormProps) {
  const defaults = autoRunDefaults(workflow)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [autoMerge, setAutoMerge] = React.useState(defaults.autoMerge)
  const [devAgent, setDevAgent] = React.useState<'codex' | 'claude'>(defaults.devAgent)
  const [reviewAgent, setReviewAgent] = React.useState<'codex' | 'claude'>(defaults.reviewAgent)
  const [maxRounds, setMaxRounds] = React.useState(defaults.maxRounds)
  const [budgetHours, setBudgetHours] = React.useState(defaults.budgetHours)
  const edited = React.useRef(false)
  const active = workflow?.autoRun

  React.useEffect(() => {
    const next = synchronizeAutoRunDraft(
      { autoMerge, devAgent, reviewAgent, maxRounds, budgetHours },
      workflow,
      edited.current,
    )
    if (edited.current) return
    setAutoMerge(next.autoMerge)
    setDevAgent(next.devAgent)
    setReviewAgent(next.reviewAgent)
    setMaxRounds(next.maxRounds)
    setBudgetHours(next.budgetHours)
  }, [autoMerge, budgetHours, devAgent, maxRounds, reviewAgent, workflow, workflow?.devAgent, workflow?.reviewAgent])

  const start = async () => {
    setBusy(true)
    setError(null)
    const autoRun = { autoMerge, devAgent, reviewAgent, maxRounds, budgetHours }
    try {
      const authorized = await apiCall<
        { ok: true; authorizationId: string; authorizationDigest: string } | { ok: false; error: string }
      >('authorize', {
        action: 'auto',
        url,
        autoRun,
        expectedSnapshot: expectedDevelopSnapshot(url, issue),
      })
      if (!authorized.ok) throw new Error(authorized.error)
      const confirmed = window.confirm(
        `自动跑到底配置\n\n开发:${devAgent}\nReview:${reviewAgent}\n轮次上限:${maxRounds}\n总预算:${budgetHours} 小时\n自动合并:${autoMerge ? '开(全部门禁仍生效)' : '关(停在待合并)'}\n授权:${authorized.authorizationDigest.slice(0, 12)}\n\n确认启动?`,
      )
      if (!confirmed) return
      const result = await apiCall<{ ok: true; workflowKey: string } | { ok: false; error: string }>('auto', {
        url,
        autoRun,
        authorizationId: authorized.authorizationId,
        authorizationDigest: authorized.authorizationDigest,
      })
      if (!result.ok) throw new Error(result.error)
      setOpen(false)
      await onStarted()
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`cv-auto-run${compact ? ' cv-auto-run-compact' : ''}`}>
      <button
        className="cv-auto-run-trigger"
        disabled={busy || active?.status === 'running'}
        onClick={() => setOpen((value) => !value)}
        title="开发、建 PR、Review 与返工自动对账推进;默认停在待合并"
      >
        {active?.status === 'running'
          ? `自动运行 · 第 ${active.step ?? 0} 步 · 已完成 ${active.rounds}/${active.maxRounds} 轮`
          : '自动跑到底'}
      </button>
      {active?.status === 'paused' ? (
        <div className="cv-auto-run-status cv-auto-run-paused">
          已暂停:{AUTO_RUN_PAUSE_LABEL[active.pausedReason ?? ''] ?? active.pausedReason}
        </div>
      ) : active?.status === 'completed' ? (
        <div className="cv-auto-run-status">已到待合并</div>
      ) : null}
      {active?.status === 'paused' && active.unresolved.length > 0 ? (
        <details className="cv-auto-run-findings">
          <summary>未解决意见({unresolvedFindingCount(workflow)})</summary>
          {active.unresolved.map((round) => (
            <ul key={round.round}>
              {round.issues.map((finding, index) => (
                <li key={`${round.round}-${index}`}>
                  第 {round.round} 轮:{finding}
                </li>
              ))}
            </ul>
          ))}
        </details>
      ) : null}
      {open ? (
        <div className="cv-auto-run-form">
          <label>
            开发 agent
            <select
              value={devAgent}
              onChange={(event) => {
                edited.current = true
                setDevAgent(event.target.value as 'codex' | 'claude')
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            Review agent
            <select
              value={reviewAgent}
              onChange={(event) => {
                edited.current = true
                setReviewAgent(event.target.value as 'codex' | 'claude')
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            轮次上限
            <input
              type="number"
              min={1}
              step={1}
              value={maxRounds}
              onChange={(event) => {
                edited.current = true
                setMaxRounds(Number(event.target.value))
              }}
            />
          </label>
          <label>
            总预算(小时)
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={budgetHours}
              onChange={(event) => {
                edited.current = true
                setBudgetHours(Number(event.target.value))
              }}
            />
          </label>
          <label className="cv-auto-run-check">
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(event) => {
                edited.current = true
                setAutoMerge(event.target.checked)
              }}
            />
            自动合并(显式开启)
          </label>
          <button disabled={busy || maxRounds < 1 || budgetHours <= 0} onClick={() => void start()}>
            {busy ? '启动中…' : '确认配置并预览授权'}
          </button>
          {error ? <div className="cv-dev-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
