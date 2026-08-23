import React from 'react'
import { formatElapsed } from './runtime.ts'

type DeliveryKind = 'dev' | 'review' | 'rework' | 'resume' | 'note' | 'merge-override'

/** Compact completed-run duration; hour-scale entries intentionally omit seconds. */
export function deliveryDurationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${seconds}s`
}

export function RunningDuration({
  startedAt,
  now,
  compact = false,
}: {
  startedAt: number
  now?: number
  compact?: boolean
}) {
  const [current, setCurrent] = React.useState(() => now ?? Date.now())

  React.useEffect(() => {
    if (now !== undefined) return
    setCurrent(Date.now())
    const timer = window.setInterval(() => setCurrent(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [now, startedAt])

  return React.createElement(
    'span',
    { className: 'cv-running-duration', 'aria-label': compact ? '任务已运行时长' : undefined },
    `${compact ? '' : '正在运行 · 已运行 '}${formatElapsed(current - startedAt)}`,
  )
}

export function DeliveryDuration({ kind, durationMs }: { kind: DeliveryKind; durationMs?: number }) {
  if ((kind !== 'dev' && kind !== 'rework' && kind !== 'review') || !Number.isFinite(durationMs)) return null
  return React.createElement('span', { className: 'cv-tl-duration' }, `耗时 ${deliveryDurationLabel(durationMs ?? 0)}`)
}
