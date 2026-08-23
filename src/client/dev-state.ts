import React from 'react'
import { clearedContext, contextToSubmit, toggledContext } from './action-context.ts'
import { useAgentAuthorization } from './agent-authorization.ts'
import { useDevStream } from './dev-stream.ts'
import { type MergeGateFailure, type NextAction, OVERRIDE_REASON_MAX, type Workflow, apiCall } from './domain.ts'
import { githubCompareUrl } from './runtime.ts'
import { type GhIssue } from './views/issue-view.tsx'
export function useDevSection({
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
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [overrideGates, setOverrideGates] = React.useState<MergeGateFailure[] | null>(null)
  const [agentChoice, setAgentChoice] = React.useState<'codex' | 'claude'>(
    () => workflow?.reviewAgent ?? workflow?.devAgent ?? 'codex',
  )
  const [contextOpen, setContextOpen] = React.useState(false)
  const [contextText, setContextText] = React.useState('')
  const authorizationFlow = useAgentAuthorization({
    url,
    issue,
    workflowBaseRef: workflow?.baseRef,
    setError,
    setOverrideGates,
  })
  const autoActionConsumedRef = React.useRef(false)
  const derived = workflow?.derived
  const stage = derived?.status ?? workflow?.stage ?? 'idle'
  const nextAction = derived?.nextAction
  const workflowEvents = workflow?.events ?? []
  const lastDelivery = [...workflowEvents].reverse().find((event) => event.kind === 'dev' || event.kind === 'rework')
  const refresh = async () => {
    const res = await apiCall<{ ok: true; workflows: Workflow[] }>('state', { url })
    if (res.ok) onWorkflow(res.workflows.find((item) => item.url === url) ?? null)
  }
  const { activeTaskId, historyKind, logEvents, openStream, setHistoryKind, setLogEvents, streamNotice, streamState } =
    useDevStream(workflow, refresh)
  React.useEffect(() => {
    const preferred = workflow?.reviewAgent ?? workflow?.devAgent
    setAgentChoice(preferred ?? 'codex')
  }, [workflow?.reviewAgent, workflow?.devAgent])
  const { authorize } = authorizationFlow
  const clearUserContext = () => {
    const next = clearedContext()
    setContextText(next.text)
    setContextOpen(next.open)
  }
  const startDev = async (agent: 'codex' | 'claude' | 'dryrun', context?: string) => {
    setBusy('developing')
    setError(null)
    setLogEvents([])
    setHistoryKind(null)
    try {
      const authorization = agent === 'dryrun' ? {} : await authorize('develop', agent, context ?? '')
      if (agent !== 'dryrun' && !authorization) {
        setBusy(null)
        return
      }
      const res = await apiCall<
        { ok: true; taskId: string; worktree: string; branch: string } | { ok: false; error: string }
      >('develop', { url, agent, ...(context ? { context } : {}), ...authorization })
      if (!res.ok) {
        setError(res.error)
        setBusy(null)
        return
      }
      clearUserContext()
      await refresh()
      void openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  const resume = async (context?: string) => {
    setBusy('resuming')
    setError(null)
    setLogEvents([])
    setHistoryKind(null)
    try {
      const agent = workflow?.devAgent ?? 'codex'
      const authorization = await authorize('resume', agent, context ?? '')
      if (!authorization) {
        setBusy(null)
        return
      }
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('resume', {
        url,
        agent,
        ...(context ? { context } : {}),
        ...authorization,
      })
      if (!res.ok) {
        setError(res.error)
        setBusy(null)
        return
      }
      clearUserContext()
      await refresh()
      void openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  const startReview = async (agent: 'codex' | 'claude', context = '') => {
    setBusy('reviewing')
    setError(null)
    setLogEvents([])
    setHistoryKind(null)
    try {
      const authorization = await authorize('review', agent, context)
      if (!authorization) {
        setBusy(null)
        return
      }
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('review', {
        url,
        agent,
        ...(context ? { context } : {}),
        ...authorization,
      })
      if (!res.ok) {
        setError(res.error)
        setBusy(null)
        return
      }
      clearUserContext()
      await refresh()
      void openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  const stop = async () => {
    if (!activeTaskId) return
    const res = await apiCall<{ ok: boolean; error?: string }>('stop', { taskId: activeTaskId })
    if (!res.ok) setError(res.error ?? '停止失败')
  }
  const syncWorktree = async () => {
    setBusy('syncing')
    setError(null)
    try {
      const res = await apiCall<
        | { ok: true; worktree: string; branch: string; head: string | null }
        | { ok: false; error: string; conflict?: boolean }
      >('sync', { url })
      if (!res.ok) {
        setError(res.error)
        // 冲突现场保留后,唯一动作会切换为「按意见返工」,刷新让按钮立即接手
        if (res.conflict) await refresh()
        // sync 没有 LiveTask/SSE;主动重载磁盘日志显示同步/冲突结果。
        if (workflow?.devTaskId) void openStream(workflow.devTaskId, false)
        setBusy(null)
        return
      }
      await refresh()
      if (workflow?.devTaskId) void openStream(workflow.devTaskId, false)
      setBusy(null)
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  const mergeAndCleanup = async () => {
    setBusy('merging')
    setError(null)
    setOverrideGates(null)
    try {
      const authorization = await authorize('merge', null)
      if (!authorization) {
        setBusy(null)
        return
      }
      const res = await apiCall<
        | { ok: true; merged: true; archived: true; prNumber: string }
        | { ok: false; error: string; merged?: boolean; cleanupPending?: boolean; gateFailures?: MergeGateFailure[] }
      >('merge', { url, ...authorization })
      if (!res.ok) {
        setError(res.error)
        setOverrideGates(res.gateFailures ?? null)
        if (res.merged) await refresh()
        setBusy(null)
        return
      }
      await refresh()
      setBusy(null)
      onDelivered?.()
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  // 人工放行(issue #49):门禁拒绝后的兜底出口。独立二次确认——服务端重新
  // 弹预览并列出本次跳过的门禁项,用户逐项确认、填写放行原因后才执行;
  // 放行记录写入 workflow 时间线,且只跳过 ClickVibe 自身门禁,GitHub 侧
  // 保护(protected branch / required reviews)不受影响。
  const mergeWithOverride = async () => {
    setBusy('merging')
    setError(null)
    setOverrideGates(null)
    try {
      const reasonInput = window.prompt(
        `人工放行合并(必填,1-${OVERRIDE_REASON_MAX} 字):\n请填写放行原因,将写入 workflow 审计时间线:`,
      )
      if (reasonInput === null) {
        setBusy(null)
        return
      }
      const reason = reasonInput.trim()
      if (reason === '') {
        setError('人工放行需要填写放行原因')
        setBusy(null)
        return
      }
      if (reason.length > OVERRIDE_REASON_MAX) {
        setError(`放行原因超长(当前 ${reason.length} 字,上限 ${OVERRIDE_REASON_MAX} 字),请精简后重试`)
        setBusy(null)
        return
      }
      const res = await apiCall<
        | {
            ok: true
            authorizationId: string
            authorizationDigest: string
            target?: { prNumber: string; branch: string; head: string; mergeFlag: '--merge' }
            override?: { skipped: string[]; reason: string }
            preview: {
              prNumber?: string
              branch?: string
              mergeFlag?: string
              cleanup?: string[]
              override?: { skipped: string[]; reason: string; gates: MergeGateFailure[] }
            }
          }
        | { ok: false; error: string; gateFailures?: MergeGateFailure[] }
      >('authorize', { action: 'merge', url, override: true, overrideReason: reason })
      if (!res.ok) {
        setError(res.error)
        setOverrideGates(res.gateFailures ?? null)
        setBusy(null)
        return
      }
      const override = res.override ?? res.preview.override
      if (override && override.skipped.length > 0) {
        // 逐项确认:每一项被跳过的门禁都单独确认(文案用服务端下发的 message),任一取消即中止。
        const gates = res.preview.override?.gates ?? []
        const gateMessage = (key: string): string => gates.find((item) => item.key === key)?.message ?? key
        for (const key of override.skipped) {
          const confirmed = window.confirm(
            `人工放行 · 逐项确认\n\n即将跳过 ClickVibe 合并门禁项:\n\n• ${gateMessage(key)}\n\n确认跳过这一项并继续?`,
          )
          if (!confirmed) {
            setBusy(null)
            return
          }
        }
        const preview = res.preview
        const confirmedMerge = window.confirm(
          `⚠️ 人工放行合并(最后确认)\n\nPR: #${preview.prNumber ?? '?'}\n分支: ${preview.branch ?? '?'}\n策略: ${preview.mergeFlag ?? '--merge'} (merge commit)\n清理: ${(preview.cleanup ?? []).join('、')}\n\n跳过的门禁项:\n${override.skipped.map((key) => `• ${gateMessage(key)}`).join('\n')}\n放行原因: ${override.reason}\n操作者: 本机用户(将写入审计时间线)\n\n注意:仅跳过 ClickVibe 自身门禁;GitHub 分支保护若拒绝合并将直接报错。\n\n确认放行并执行合并与清理?`,
        )
        if (!confirmedMerge) {
          setBusy(null)
          return
        }
      } else {
        // 确认时门禁已全部通过(此前拒绝基于过期数据):按正常合并预览确认。
        const preview = res.preview
        const confirmedMerge = window.confirm(
          `门禁已全部通过,无需放行。ClickVibe 将执行不可逆的合并与清理:\n\nPR: #${preview.prNumber ?? '?'}\n分支: ${preview.branch ?? '?'}\n策略: ${preview.mergeFlag ?? '--merge'}\n清理: ${(preview.cleanup ?? []).join('、')}\n\n确认合并并清理?`,
        )
        if (!confirmedMerge) {
          setBusy(null)
          return
        }
      }
      const mergeRes = await apiCall<
        | { ok: true; merged: true; archived: true; prNumber: string }
        | { ok: false; error: string; merged?: boolean; cleanupPending?: boolean; gateFailures?: MergeGateFailure[] }
      >('merge', {
        url,
        authorizationId: res.authorizationId,
        authorizationDigest: res.authorizationDigest,
        ...(res.target ? { target: res.target } : {}),
        ...(res.override ? { override: res.override } : {}),
      })
      if (!mergeRes.ok) {
        setError(mergeRes.error)
        setOverrideGates(mergeRes.gateFailures ?? null)
        if (mergeRes.merged) await refresh()
        setBusy(null)
        return
      }
      await refresh()
      setBusy(null)
      onDelivered?.()
    } catch (e) {
      setError(String(e))
      setBusy(null)
    }
  }
  // 唯一动作:服务端由 git 事实推导;issue 已关闭时本地覆盖为无动作
  const issueClosed = String(issue.state ?? '').toUpperCase() === 'CLOSED'
  // #5 回归修复:从未开发过(无 workflow 记录)的 OPEN issue,服务端 /api/state
  // 只枚举已持久化 workflow,不会为其推导 nextAction(恒为 undefined),导致按钮
  // 缺失。这里按 deriveNextAction 的 idle 分支本地兜底为『开始开发』;
  // 有 workflow 记录时仍以服务端推导为准。
  const idleDevelop: NextAction = { kind: 'develop', label: '开始开发', hint: '创建 worktree 并启动 agent 开发' }
  const effectiveAction: NextAction =
    issueClosed && nextAction?.kind !== 'cleanup'
      ? { kind: 'none', label: '无', hint: 'issue 已关闭,无待办动作' }
      : (nextAction ?? (workflow === null ? idleDevelop : { kind: 'none', label: '无', hint: '等待状态…' }))
  const runAction = () => {
    const userContext = contextToSubmit(contextText)
    switch (effectiveAction.kind) {
      case 'develop':
        void startDev(agentChoice, userContext)
        break
      case 'resume':
        void resume(userContext)
        break
      // 返工:textarea 预填当前 review 意见(可编辑),发送以输入框最终文本为准;
      // 清空也不影响服务端既有的 review 意见自动注入(issue #54)。
      case 'rework':
        void resume(userContext)
        break
      case 'review':
        void startReview(agentChoice, userContext)
        break
      case 'sync':
        void syncWorktree()
        break
      case 'create-pr':
        if (workflow) {
          window.open(
            githubCompareUrl(workflow.repoKey, workflow.branch, workflow.baseRef, workflow.derived?.baseBranch),
            '_blank',
            'noopener',
          )
        }
        break
      case 'merge':
      case 'cleanup':
        void mergeAndCleanup()
        break
      case 'none':
        break
    }
  }
  React.useEffect(() => {
    if (!autoAction) {
      autoActionConsumedRef.current = false
      return
    }
    if (autoActionConsumedRef.current || effectiveAction.kind === 'none') return
    autoActionConsumedRef.current = true
    onAutoActionHandled?.()
    runAction()
    // The parent owns the one-shot trigger; use the currently rendered issue snapshot.
  }, [autoAction])
  // review 锁定:从未 review 过则两个 agent 都可选;锁过只留那个
  const lockedAgent = effectiveAction.kind === 'review' ? (workflow?.reviewAgent ?? null) : null
  const showAgentToggle = effectiveAction.kind === 'develop' || effectiveAction.kind === 'review'
  // 附加说明(issue #54):仅 develop/resume/rework/review 支持;merge/cleanup/sync 不加。
  const contextSupported =
    effectiveAction.kind === 'develop' ||
    effectiveAction.kind === 'resume' ||
    effectiveAction.kind === 'rework' ||
    effectiveAction.kind === 'review'
  const toggleContext = () => {
    // 返工首次展开时预填当前 review 意见(纯函数判定,见 action-context.ts)。
    const prefillIssues = workflow?.reviewResult && !workflow.reviewResult.passed ? workflow.reviewResult.issues : null
    const next = toggledContext({ open: contextOpen, text: contextText }, effectiveAction.kind, prefillIssues)
    setContextText(next.text)
    setContextOpen(next.open)
  }
  const actionButtonClass =
    effectiveAction.kind === 'merge' || effectiveAction.kind === 'cleanup'
      ? 'cv-dev-btn cv-dev-merge'
      : effectiveAction.kind === 'sync'
        ? 'cv-dev-btn cv-dev-sync'
        : effectiveAction.kind === 'review'
          ? 'cv-dev-btn cv-dev-review'
          : effectiveAction.kind === 'resume' || effectiveAction.kind === 'rework'
            ? 'cv-dev-btn cv-dev-warn'
            : 'cv-dev-btn cv-dev-codex'
  const busyLabel =
    busy === 'merging'
      ? '合并并清理中…'
      : busy === 'syncing'
        ? '同步中…'
        : busy === 'resuming'
          ? '恢复中…'
          : busy === 'reviewing'
            ? 'Review 中…'
            : busy === 'developing'
              ? '启动中…'
              : null
  // 人工放行入口(issue #49):合并尝试被门禁拒绝后(动态),或 review 已通过
  // 但结论/契约过期、面板停留在「重新 Review」/「无法读取契约」时(静态)。
  const overrideEntryVisible =
    overrideGates !== null ||
    Boolean(
      workflow?.prNumber &&
        workflow.reviewResult?.passed === true &&
        derived &&
        !derived.verdictCurrent &&
        !issueClosed &&
        busy === null &&
        (effectiveAction.kind === 'review' ||
          (effectiveAction.kind === 'none' && derived.issueContractUnknownReason === 'current-contract-unavailable')),
    )
  return {
    ...authorizationFlow,
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
    runAction,
    setAgentChoice,
    setContextText,
    showAgentToggle,
    stage,
    startDev,
    stop,
    streamNotice,
    streamState,
    toggleContext,
    workflowEvents,
  }
}
