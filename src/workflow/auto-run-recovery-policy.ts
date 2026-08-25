import type { AutoRunState, WorkflowEvent } from '../infra/state.ts'

export const AUTO_RUN_BASE_RETRY_MS = 5_000
export const AUTO_RUN_MAX_RETRY_MS = 5 * 60_000
export const AUTO_RUN_FUSE_THRESHOLD = 3
export const AUTO_RUN_WATCHDOG_COOLDOWN_MS = 5 * 60_000
export const AUTO_RUN_WATCHDOG_LIMIT = 10
export const AUTO_RUN_WATCHDOG_WINDOW_MS = 60 * 60_000
export const AUTO_RUN_WATCHDOG_NOTE = '看门狗自动重挂 controller-error'

export interface ControllerFailureEvidence {
  name: string
  message: string
  stack: string | null
}

export interface ControllerFailureAttempt extends ControllerFailureEvidence {
  attempt: number
  consecutive: number
  fingerprint: string
  delayMs: number
  retryAt: number
  fused: boolean
}

function stableFingerprint(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function controllerFailureEvidence(error: unknown): ControllerFailureEvidence {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null }
  }
  return { name: typeof error, message: String(error), stack: null }
}

/** Pure capped exponential backoff. A successful reconcile clears the previous attempt. */
export function nextControllerFailure(
  previous: ControllerFailureAttempt | null,
  evidence: ControllerFailureEvidence,
  now: number,
  random: number,
): ControllerFailureAttempt {
  const identity = evidence.stack?.trim() || `${evidence.name}:${evidence.message}`
  const fingerprint = stableFingerprint(identity)
  const attempt = (previous?.attempt ?? 0) + 1
  const consecutive = previous?.fingerprint === fingerprint ? previous.consecutive + 1 : 1
  const exponent = Math.min(attempt - 1, 16)
  const uncapped = AUTO_RUN_BASE_RETRY_MS * 2 ** exponent
  const jitter = 0.75 + Math.max(0, Math.min(1, random)) * 0.5
  const delayMs = Math.min(AUTO_RUN_MAX_RETRY_MS, Math.round(uncapped * jitter))
  return {
    ...evidence,
    attempt,
    consecutive,
    fingerprint,
    delayMs,
    retryAt: now + delayMs,
    fused: consecutive >= AUTO_RUN_FUSE_THRESHOLD,
  }
}

export type AutoRunWatchdogDecision =
  | { kind: 'none' }
  | { kind: 'reattach' }
  | { kind: 'budget-exhausted' }
  | { kind: 'session-interrupted' }
  | { kind: 'wait'; retryAt: number; reason: 'cooldown' | 'ownership-unknown' | 'hourly-limit' }

function watchdogEvents(events: readonly WorkflowEvent[], now: number): WorkflowEvent[] {
  const cutoff = now - AUTO_RUN_WATCHDOG_WINDOW_MS
  return events.filter(
    (event) => event.kind === 'auto-run' && event.note === AUTO_RUN_WATCHDOG_NOTE && Date.parse(event.at) > cutoff,
  )
}

/** Pure watchdog gate. Runtime code must re-observe ownership immediately before applying it. */
export function decideAutoRunWatchdog(
  autoRun: AutoRunState,
  events: readonly WorkflowEvent[],
  ownership: 'none' | 'running' | 'unknown' | 'interrupted',
  now: number,
): AutoRunWatchdogDecision {
  if (autoRun.status !== 'paused' || autoRun.pausedReason !== 'controller-error') return { kind: 'none' }
  if (now >= Date.parse(autoRun.deadline)) return { kind: 'budget-exhausted' }
  if (ownership === 'interrupted') return { kind: 'session-interrupted' }
  if (ownership === 'unknown') {
    return { kind: 'wait', retryAt: now + AUTO_RUN_BASE_RETRY_MS, reason: 'ownership-unknown' }
  }
  const cooldownAt = autoRun.controllerRecovery?.retryAt
    ? Date.parse(autoRun.controllerRecovery.retryAt)
    : Date.parse(autoRun.lastObservedAt ?? autoRun.startedAt) + AUTO_RUN_WATCHDOG_COOLDOWN_MS
  if (Number.isFinite(cooldownAt) && now < cooldownAt) {
    return { kind: 'wait', retryAt: cooldownAt, reason: 'cooldown' }
  }
  const recent = watchdogEvents(events, now)
  if (recent.length >= AUTO_RUN_WATCHDOG_LIMIT) {
    const oldest = Math.min(...recent.map((event) => Date.parse(event.at)))
    return { kind: 'wait', retryAt: oldest + AUTO_RUN_WATCHDOG_WINDOW_MS, reason: 'hourly-limit' }
  }
  return { kind: 'reattach' }
}
