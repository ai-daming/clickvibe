import { RunningDuration } from '../duration.ts'
import { type Workflow, stageLabel } from '../domain.ts'
import { type GhIssue } from './issue-view.tsx'
import { LiveTerminal } from './live-terminal.tsx'
import { useDevSection } from '../dev-state.ts'
import { DeliveryTimeline } from './delivery-timeline.tsx'
import { AutoRunForm } from './auto-run-form.tsx'
import { apiCall } from '../domain.ts'
import { contextToSubmit } from '../action-context.ts'
import { freshSessionEntry } from '../fresh-session.ts'

export function DevSection({
  url,
  issue,
  workflow,
  onWorkflow,
  autoAction,
  onAutoActionHandled,
  onDelivered,
}: {
  url: string
  issue: GhIssue
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  autoAction?: boolean
  onAutoActionHandled?: () => void
  onDelivered?: () => void
}) {
  const {
    actionButtonClass,
    activeTaskId,
    agentChoice,
    busy,
    busyLabel,
    contextOpen,
    contextSupported,
    contextText,
    derived,
    effectiveAction,
    error,
    historyKind,
    lastDelivery,
    lockedAgent,
    logEvents,
    mergeWithOverride,
    overrideEntryVisible,
    overrideGates,
    openStream,
    runAction,
    setAgentChoice,
    setContextText,
    showAgentToggle,
    stage,
    startDev,
    startReview,
    stop,
    streamNotice,
    streamState,
    toggleContext,
    resume,
    workflowEvents,
  } = useDevSection({ url, issue, workflow, onWorkflow, autoAction, onAutoActionHandled, onDelivered })
  const freshEntry = freshSessionEntry(effectiveAction.kind, derived?.freshSession)
  const runFreshSession = () => {
    const userContext = contextToSubmit(contextText)
    if (freshEntry === 'develop') void resume(userContext, true)
    if (freshEntry === 'review') void startReview(agentChoice, userContext, true)
  }
  return (
    <div className="cv-dev">
      {/* 状态卡:当前状态 + 关键事实 */}
      <div className="cv-dev-head">
        🚀 开发流程 <span className={`cv-stage cv-stage-${stage}`}>{stageLabel(stage, workflow)}</span>
        {workflow?.runStartedAt !== null &&
        workflow?.runStartedAt !== undefined &&
        (derived?.status === 'developing' || derived?.status === 'reviewing') ? (
          <RunningDuration startedAt={workflow.runStartedAt} />
        ) : null}
        {derived?.hasNewCommits ? <span className="cv-stage cv-stage-new">有未 review 的新提交</span> : null}
      </div>
      <AutoRunForm
        url={url}
        issue={issue}
        workflow={workflow}
        onStarted={async () => {
          const state = await apiCall<{ ok: true; workflows: Workflow[] }>('state', { url })
          if (state.ok) onWorkflow(state.workflows.find((item) => item.url === url) ?? null)
        }}
      />
      {workflow?.worktree ? <div className="cv-dev-path">{workflow.worktree}</div> : null}
      {workflow?.prNumber ? (
        <div className="cv-dev-path">
          🔗 PR{' '}
          <a
            className="cv-link"
            href={`https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}`}
            target="_blank"
            rel="noreferrer"
          >
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
                    <span className="cv-state-delta">
                      worktree 落后 {derived.behindMain} · 领先 {derived.aheadOfMain}
                    </span>
                  </td>
                </tr>
              ) : null}
              {derived.originMainHead ? (
                <tr>
                  <td className="cv-state-k">远端</td>
                  <td className="cv-state-v">
                    origin/main <code className="cv-tl-hash">{derived.originMainHead}</code>
                    <span className="cv-state-delta">
                      worktree 落后 {derived.behindBase} · 领先 {derived.aheadOfBase}
                    </span>
                    {derived.needsSync ? <span className="cv-state-warn">⚠ 需要同步</span> : null}
                    {derived.mergeConflict ? <span className="cv-state-warn">⚠ 合并冲突待解决(转交 agent)</span> : null}
                  </td>
                </tr>
              ) : null}
              {derived.upstreamHead ? (
                <tr>
                  <td className="cv-state-k">远端分支</td>
                  <td className="cv-state-v">
                    origin/{derived.branch ?? workflow?.branch}{' '}
                    <code className="cv-tl-hash">{derived.upstreamHead}</code>
                    <span className="cv-state-delta">
                      worktree 落后 {derived.behindUpstream ?? 0} · 领先 {derived.aheadOfUpstream ?? 0}
                    </span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* review 结论同时绑定 HEAD 与 Issue 正文契约；任一变化都不冒充当前结论。 */}
      {workflow?.reviewResult ? (
        <div
          className={
            derived?.verdictCurrent
              ? workflow.reviewResult.passed
                ? 'cv-dev-done'
                : 'cv-review-fail'
              : 'cv-review-stale'
          }
        >
          {derived?.verdictCurrent
            ? workflow.reviewResult.passed
              ? `✅ Review 通过(针对提交 ${derived.reviewedHash ?? '?'})`
              : `❌ Review 发现 ${workflow.reviewResult.issues.length} 个问题(针对提交 ${derived.reviewedHash ?? '?'})`
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
          {workflow.reviewResult.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
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
                <button
                  className={agentChoice === 'codex' ? 'on' : ''}
                  onClick={() => setAgentChoice('codex')}
                  disabled={lockedAgent !== null && lockedAgent !== 'codex'}
                >
                  Codex
                </button>
                <button
                  className={agentChoice === 'claude' ? 'on' : ''}
                  onClick={() => setAgentChoice('claude')}
                  disabled={lockedAgent !== null && lockedAgent !== 'claude'}
                >
                  Claude
                </button>
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
            {freshEntry ? (
              <button
                className="cv-dev-link"
                onClick={runFreshSession}
                disabled={busy !== null}
                title="放弃旧会话上下文，以当前需求快照和 worktree 状态启动全新会话；Git 产物保持不变"
              >
                {freshEntry === 'develop' ? '新开开发' : '新开 review'}
              </button>
            ) : null}
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
                    placeholder={
                      effectiveAction.kind === 'rework'
                        ? '已预填当前 Review 意见,可编辑;发送以这里的最终文本为准'
                        : '补充给 agent 的附加上下文,可留空'
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {stage === 'idle' && effectiveAction.kind === 'develop' ? (
          <button className="cv-dev-link" onClick={() => startDev('dryrun')} disabled={busy !== null}>
            安全演练(dry-run)
          </button>
        ) : null}
        {activeTaskId ? (
          <button className="cv-dev-btn cv-dev-warn" onClick={() => void stop()}>
            停止任务
          </button>
        ) : null}
      </div>

      {error ? <div className="cv-dev-error">{error}</div> : null}
      {overrideEntryVisible ? (
        <div className="cv-override-entry">
          {overrideGates ? (
            <ul className="cv-override-gates">
              {overrideGates.map((gate) => (
                <li key={gate.key}>门禁未过:{gate.message}</li>
              ))}
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
          agent={
            historyKind === 'review' ? workflow?.reviewAgent : historyKind === 'dev' ? workflow?.devAgent : agentChoice
          }
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

      <DeliveryTimeline events={workflowEvents} onOpenLog={(taskId) => void openStream(taskId, false)} />
    </div>
  )
}
