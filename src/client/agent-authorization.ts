import React from 'react'
import { type AuthorizationPreview, authorizationSummary, expectedDevelopSnapshot } from './dev-authorization.ts'
import { type MergeGateFailure, apiCall } from './domain.ts'
import type { GhIssue } from './views/issue-view.tsx'

export interface AuthorizationCapability {
  authorizationId: string
  authorizationDigest: string
  baseline?: string
  target?: { prNumber: string; branch: string; head: string; mergeFlag: '--merge' }
  restoreTarget?: { branch: string; hash: string }
}

export interface PendingDevelopAuthorization extends AuthorizationCapability {
  preview: AuthorizationPreview
  agent: 'codex' | 'claude'
  context: string
  refreshing: boolean
}

interface AuthorizationResponse extends AuthorizationCapability {
  ok: true
  preview: AuthorizationPreview
}

function frozenBaseline(baseRef: string | null | undefined): string {
  const ref = String(baseRef ?? '')
    .split(/\s+@\s+/, 1)[0]
    .trim()
    .replace(/^refs\/remotes\//, '')
  return ref.startsWith('origin/') ? ref : 'origin/HEAD'
}

/** Own the two-stage develop dialog while preserving window confirmation for other actions. */
export function useAgentAuthorization(options: {
  url: string
  issue: GhIssue
  workflowBaseRef: string | null | undefined
  setError: (error: string | null) => void
  setOverrideGates: (gates: MergeGateFailure[] | null) => void
}) {
  const { url, issue, workflowBaseRef, setError, setOverrideGates } = options
  const [pendingDevelop, setPendingDevelop] = React.useState<PendingDevelopAuthorization | null>(null)
  const resolver = React.useRef<((value: AuthorizationCapability | null) => void) | null>(null)

  const request = async (
    action: 'develop' | 'review' | 'resume' | 'merge' | 'restore-base',
    agent: 'codex' | 'claude' | null,
    context: string,
    baseline?: string,
  ): Promise<AuthorizationResponse | null> => {
    const expectedSnapshot = expectedDevelopSnapshot(url, issue)
    const res = await apiCall<AuthorizationResponse | { ok: false; error: string; gateFailures?: MergeGateFailure[] }>(
      'authorize',
      {
        action,
        url,
        ...(agent ? { agent } : {}),
        context,
        ...(action === 'develop' ? { expectedSnapshot, baseline: baseline ?? frozenBaseline(workflowBaseRef) } : {}),
      },
    )
    if (!res.ok) {
      setError(res.error)
      setOverrideGates(res.gateFailures ?? null)
      return null
    }
    return res
  }

  const authorize = async (
    action: 'develop' | 'review' | 'resume' | 'merge' | 'restore-base',
    agent: 'codex' | 'claude' | null,
    context = '',
  ): Promise<AuthorizationCapability | null> => {
    const prepared = await request(action, agent, context)
    if (!prepared) return null
    if (action === 'develop' && agent) {
      return new Promise((resolve) => {
        resolver.current = resolve
        setPendingDevelop({ ...prepared, agent, context, refreshing: false })
      })
    }
    const summary = authorizationSummary({
      action,
      agent,
      url,
      authorizationDigest: prepared.authorizationDigest,
      preview: prepared.preview,
    })
    return window.confirm(summary) ? prepared : null
  }

  const chooseBaseline = async (baseline: string) => {
    const current = pendingDevelop
    if (!current || current.preview.baselineFrozen || baseline === current.preview.baseline) return
    setPendingDevelop({ ...current, refreshing: true })
    const refreshed = await request('develop', current.agent, current.context, baseline)
    if (refreshed)
      setPendingDevelop({ ...refreshed, agent: current.agent, context: current.context, refreshing: false })
    else setPendingDevelop({ ...current, refreshing: false })
  }

  const finishDevelop = (confirmed: boolean) => {
    const current = pendingDevelop
    setPendingDevelop(null)
    const resolve = resolver.current
    resolver.current = null
    if (!resolve) return
    resolve(
      confirmed && current
        ? {
            authorizationId: current.authorizationId,
            authorizationDigest: current.authorizationDigest,
            baseline: current.preview.baseline ?? 'origin/HEAD',
          }
        : null,
    )
  }

  React.useEffect(() => () => resolver.current?.(null), [])

  return {
    authorize,
    cancelDevelopAuthorization: () => finishDevelop(false),
    chooseBaseline,
    confirmDevelopAuthorization: () => finishDevelop(true),
    pendingDevelopAuthorization: pendingDevelop,
  }
}
