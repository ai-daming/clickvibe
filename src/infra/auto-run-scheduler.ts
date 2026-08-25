import type { Context } from '@deepseek-ai/cordis'

export type AutoRunWake = (ctx: Context, key: string) => void

interface AutoRunScheduleState {
  wakeTimers: Map<string, ReturnType<typeof setTimeout>>
  deadlineTimers: Map<string, ReturnType<typeof setTimeout>>
}

const scheduleStateSymbol = Symbol.for('clickvibe.auto-run-schedule-state')
const root = globalThis as unknown as Record<PropertyKey, unknown>
const scheduleState = (root[scheduleStateSymbol] as AutoRunScheduleState | undefined) ?? {
  wakeTimers: new Map(),
  deadlineTimers: new Map(),
}
root[scheduleStateSymbol] = scheduleState
const { wakeTimers, deadlineTimers } = scheduleState

function clearWake(key: string): void {
  const timer = wakeTimers.get(key)
  if (timer) clearTimeout(timer)
  wakeTimers.delete(key)
}

function clearDeadline(key: string): void {
  const timer = deadlineTimers.get(key)
  if (timer) clearTimeout(timer)
  deadlineTimers.delete(key)
}

export function autoRunWakePending(key: string): boolean {
  return wakeTimers.has(key)
}

export function clearAutoRunSchedule(key: string): void {
  clearWake(key)
  clearDeadline(key)
}

export function scheduleAutoRunWakeAt(ctx: Context, key: string, retryAt: number, wake: AutoRunWake): void {
  clearWake(key)
  const delay = Math.max(0, retryAt - Date.now())
  const timer = setTimeout(
    () => {
      wakeTimers.delete(key)
      wake(ctx, key)
    },
    Math.min(delay, 2_147_483_647),
  )
  timer.unref?.()
  wakeTimers.set(key, timer)
}

export function scheduleAutoRunWake(
  ctx: Context,
  key: string,
  retryAt: number,
  deadline: string,
  wake: AutoRunWake,
): void {
  const deadlineAt = Date.parse(deadline)
  const target = Number.isFinite(deadlineAt) ? Math.min(retryAt, deadlineAt) : retryAt
  scheduleAutoRunWakeAt(ctx, key, target, wake)
}

export function armAutoRunDeadline(ctx: Context, key: string, deadline: string, wake: AutoRunWake): void {
  clearDeadline(key)
  const delay = Math.max(0, Date.parse(deadline) - Date.now())
  const timer = setTimeout(
    () => {
      deadlineTimers.delete(key)
      wake(ctx, key)
    },
    Math.min(delay, 2_147_483_647),
  )
  timer.unref?.()
  deadlineTimers.set(key, timer)
}
