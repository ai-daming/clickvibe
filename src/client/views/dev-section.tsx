
import { deliveryPublicationLabel, } from '../runtime.ts'
import { type Workflow, fmtTime, stageLabel } from '../domain.ts'
import { type GhIssue } from './issue-view.tsx'
import { LiveTerminal } from './live-terminal.tsx'
import { useDevSection } from '../dev-state.ts'

export function DevSection({ url, issue, workflow, onWorkflow, autoAction, onAutoActionHandled, onDelivered }: {
  url: string
  issue: GhIssue
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  autoAction?: boolean
  onAutoActionHandled?: () => void
  onDelivered?: () => void
}) {
  const { actionButtonClass, activeTaskId, agentChoice, busy, busyLabel, contextOpen, contextSupported, contextText, derived, effectiveAction, error, historyKind, lastDelivery, lockedAgent, logEvents, mergeWithOverride, overrideEntryVisible, overrideGates, runAction, setAgentChoice, setContextText, showAgentToggle, stage, startDev, stop, streamNotice, streamState, toggleContext, workflowEvents } = useDevSection({ url, issue, workflow, onWorkflow, autoAction, onAutoActionHandled, onDelivered })
  return (
    <div className="cv-dev">
      {/* 状态卡:当前状态 + 关键事实 */}
      <div className="cv-dev-head">
        🚀 开发流程 <span className={`cv-stage cv-stage-${stage}`}>{stageLabel(stage, workflow)}</span>
        {derived?.hasNewCommits ? <span className="cv-stage cv-stage-new">有未 review 的新提交</span> : null}
      </div>
      {workflow?.worktree ? <div className="cv-dev-path">{workflow.worktree}</div> : null}
      {workflow?.prNumber ? (
        <div className="cv-dev-path">
          🔗 PR{' '}
          <a className="cv-link" href={`https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}`} target="_blank" rel="noreferrer">
            #{workflow.prNumber}
          </a>
        </div>
      ) : null}
      {lastDelivery?.fixed !== undefined ? (
        <div className="cv-delivery-summary">
          {lastDelivery.fixed > 0
            ? `上次开发完成:修复 ${lastDelivery.fixed} 个 Review 问题,已请求再次 Review`
            : '上次开发完成:首次交付,已请求 Review'}
        </div>
      ) : null}

      {/* 权威状态视图:worktree / main / 远端 三方对比(issue #5) */}
      {derived ? (
        <div className="cv-state">
          <div className="cv-state-head">📊 状态视图</div>
          <table className="cv-state-table">
            <tbody>
              <tr>
                <td className="cv-state-k">worktree</td>
                <td className="cv-state-v">
                  {derived.branch ?? workflow?.branch ?? '—'} <code className="cv-tl-hash">{derived.head ?? '—'}</code>
                </td>
              </tr>
              {derived.mainHead ? (
                <tr>
                  <td className="cv-state-k">main</td>
                  <td className="cv-state-v">
                    <code className="cv-tl-hash">{derived.mainHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindMain} · 领先 {derived.aheadOfMain}</span>
                  </td>
                </tr>
              ) : null}
              {derived.originMainHead ? (
                <tr>
                  <td className="cv-state-k">远端</td>
                  <td className="cv-state-v">
                    origin/main <code className="cv-tl-hash">{derived.originMainHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindBase} · 领先 {derived.aheadOfBase}</span>
                    {derived.needsSync ? <span className="cv-state-warn">⚠ 需要同步</span> : null}
                    {derived.mergeConflict ? <span className="cv-state-warn">⚠ 合并冲突待解决(转交 agent)</span> : null}
                  </td>
                </tr>
              ) : null}
              {derived.upstreamHead ? (
                <tr>
                  <td className="cv-state-k">远端分支</td>
                  <td className="cv-state-v">
                    origin/{derived.branch ?? workflow?.branch} <code className="cv-tl-hash">{derived.upstreamHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindUpstream ?? 0} · 领先 {derived.aheadOfUpstream ?? 0}</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* review 结论同时绑定 HEAD 与 Issue 正文契约；任一变化都不冒充当前结论。 */}
      {workflow?.reviewResult ? (
        <div className={derived?.verdictCurrent ? (workflow.reviewResult.passed ? 'cv-dev-done' : 'cv-review-fail') : 'cv-review-stale'}>
          {derived?.verdictCurrent
            ? (workflow.reviewResult.passed
              ? `✅ Review 通过(针对提交 ${derived.reviewedHash ?? '?'})`
              : `❌ Review 发现 ${workflow.reviewResult.issues.length} 个问题(针对提交 ${derived.reviewedHash ?? '?'})`)
            : derived?.issueContractStatus === 'changed'
              ? `⏳ 验收已变更,需重新 Review(原契约 ${derived.reviewedIssueBodyHash?.slice(0, 12) ?? '?'},当前 ${derived.currentIssueBodyHash?.slice(0, 12) ?? '?'})`
              : derived?.issueContractUnknownReason === 'missing-review-snapshot'
                ? '⏳ 现有 Review 结论缺少验收契约快照,需重新 Review'
                : derived?.issueContractUnknownReason === 'current-contract-unavailable'
                  ? '⏸ 暂时无法读取当前验收契约,合并已暂停;请刷新后重试'
              : `⏳ Review 结论针对旧提交 ${derived?.reviewedHash ?? '?'},当前 HEAD ${derived?.head ?? '?'} 已变化,结论已过期`}
        </div>
      ) : null}
      {workflow?.reviewResult && !workflow.reviewResult.passed && derived?.verdictCurrent ? (
        <ul className="cv-review-issues">
          {workflow.reviewResult.issues.map((issue, i) => <li key={i}>{issue}</li>)}
        </ul>
      ) : null}
      {workflow?.reviewResult && derived?.verdictCurrent ? (
        <div className={`cv-review-next ${workflow.reviewResult.passed ? 'cv-tl-pass' : 'cv-tl-fail'}`}>
          下一步:{workflow.reviewResult.passed ? '可合并' : '请重新开发'}
        </div>
      ) : null}

      {/* 唯一动作 */}
      <div className="cv-dev-actions">
        {effectiveAction.kind === 'none' ? (
          <div className="cv-dev-noop">· {effectiveAction.hint}</div>
        ) : (
          <>
            {showAgentToggle ? (
              <div className="cv-agent-toggle" title={lockedAgent ? `Review 锁定 ${lockedAgent}` : '选择 agent'}>
                <button className={agentChoice === 'codex' ? 'on' : ''} onClick={() => setAgentChoice('codex')} disabled={lockedAgent !== null && lockedAgent !== 'codex'}>Codex</button>
                <button className={agentChoice === 'claude' ? 'on' : ''} onClick={() => setAgentChoice('claude')} disabled={lockedAgent !== null && lockedAgent !== 'claude'}>Claude</button>
              </div>
            ) : null}
            <button
              className={actionButtonClass}
              onClick={runAction}
              disabled={busy !== null}
              title={effectiveAction.hint}
            >
              {busyLabel ?? effectiveAction.label}
            </button>
            {contextSupported ? (
              <div className="cv-context">
                <button
                  className="cv-context-toggle"
                  onClick={toggleContext}
                  disabled={busy !== null}
                  title="展开后可填写附加说明,随动作拼入 agent prompt;留空则与现状一致"
                >
                  附加说明(可选) {contextOpen ? '▾' : '▸'}
                </button>
                {contextOpen ? (
                  <textarea
                    className="cv-context-input"
                    value={contextText}
                    onChange={(event) => setContextText(event.target.value)}
                    rows={3}
                    placeholder={effectiveAction.kind === 'rework'
                      ? '已预填当前 Review 意见,可编辑;发送以这里的最终文本为准'
                      : '补充给 agent 的附加上下文,可留空'}
                  />
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {stage === 'idle' && effectiveAction.kind === 'develop' ? (
          <button className="cv-dev-link" onClick={() => startDev('dryrun')} disabled={busy !== null}>安全演练(dry-run)</button>
        ) : null}
        {activeTaskId ? (
          <button className="cv-dev-btn cv-dev-warn" onClick={() => void stop()}>停止任务</button>
        ) : null}
      </div>

      {error ? <div className="cv-dev-error">{error}</div> : null}
      {overrideEntryVisible ? (
        <div className="cv-override-entry">
          {overrideGates ? (
            <ul className="cv-override-gates">
              {overrideGates.map((gate) => <li key={gate.key}>门禁未过:{gate.message}</li>)}
            </ul>
          ) : null}
          <button
            className="cv-dev-btn cv-dev-warn"
            disabled={busy !== null}
            title="门禁拒绝时的兜底:二次确认逐项跳过 ClickVibe 门禁后合并,GitHub 侧保护不受影响"
            onClick={() => void mergeWithOverride()}
          >
            仍要合并(人工放行)
          </button>
        </div>
      ) : null}
      {streamNotice ? <div className="cv-dev-error">{streamNotice}</div> : null}

      {activeTaskId || streamState === 'history' ? (
        <LiveTerminal
          events={logEvents}
          taskId={activeTaskId}
          active={activeTaskId !== null}
          streamState={streamState}
          agent={historyKind === 'review' ? workflow?.reviewAgent : historyKind === 'dev' ? workflow?.devAgent : agentChoice}
        />
      ) : logEvents.length > 0 ? (
        <details className="cv-log-history">
          <summary>📜 历史输出 · {logEvents.filter((event) => event.kind !== 'usage').length} 行</summary>
          <LiveTerminal
            events={logEvents}
            taskId={null}
            active={false}
            streamState="ended"
            agent={historyKind === 'review' ? workflow?.reviewAgent : historyKind === 'dev' ? workflow?.devAgent : null}
          />
        </details>
      ) : null}

      {/* 交付流水:本地事件与其公开 GitHub 评论状态,按时间倒序 */}
      {workflowEvents.length > 0 ? (
        <div className="cv-timeline">
          <div className="cv-timeline-head">📜 交付流水 · 本地事件 / GitHub 评论</div>
          {[...workflowEvents].reverse().map((ev, i) => (
            <div key={i} className="cv-tl-row">
              <span className={`cv-tl-kind cv-tl-kind-${ev.kind}`}>
                {ev.kind === 'dev' ? '开发' : ev.kind === 'rework' ? '返工' : ev.kind === 'review' ? 'Review' : ev.kind === 'resume' ? '恢复' : ev.kind === 'merge-override' ? '人工放行' : '备注'}
              </span>
              <span className="cv-tl-time">{fmtTime(ev.at)}</span>
              {ev.hash ? <code className="cv-tl-hash">{ev.hash}</code> : null}
              {ev.kind === 'merge-override' ? (
                <span className="cv-tl-note" title={ev.reason}>
                  跳过 {(ev.skippedLabels ?? ev.skipped ?? []).join('、')} · 操作者 @{ev.operator ?? '?'} · 原因:{ev.reason ?? '?'}
                </span>
              ) : null}
              {ev.kind === 'review' && ev.verdict
                ? <span className={ev.verdict.passed ? 'cv-tl-verdict cv-tl-pass' : 'cv-tl-verdict cv-tl-fail'}>
                    {ev.verdict.passed ? '✅ 通过' : `❌ ${ev.verdict.issues.length} 个问题`}
                  </span>
                : null}
              {(ev.kind === 'dev' || ev.kind === 'rework') && ev.fixed !== undefined
                ? <span className="cv-tl-note">修复 {ev.fixed} 个问题</span>
                : null}
              {ev.note ? <span className="cv-tl-note">{ev.note}</span> : null}
              {ev.userContext ? (
                <span className="cv-tl-user-context" title={ev.userContext}>
                  用户附加说明:{ev.userContext.length > 80 ? `${ev.userContext.slice(0, 80)}…` : ev.userContext}
                </span>
              ) : null}
              {ev.publication?.status === 'posted'
                ? ev.publication.url
                  ? <a className="cv-tl-public" href={ev.publication.url} target="_blank" rel="noreferrer">
                      {deliveryPublicationLabel(ev.publication)}
                    </a>
                  : <span className="cv-tl-public">{deliveryPublicationLabel(ev.publication)}</span>
                : ev.publication?.status === 'failed'
                  ? <span className="cv-tl-publish-fail" title={ev.publication.error}>{deliveryPublicationLabel(ev.publication)}</span>
                  : <span className="cv-tl-local">{deliveryPublicationLabel(ev.publication)}</span>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
