import React from 'react'

type DeliveryKind = 'dev' | 'review' | 'rework' | 'resume' | 'note' | 'merge-override'

/** Fixed-width live counter used by both issue detail and repository rows. */
export function runningDurationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':')
}

/** Compact completed-run duration; hour-scale entries intentionally omit seconds. */
export function deliveryDurationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${seconds}s`
}

export function RunningDuration({ startedAt, now }: { startedAt: number; now?: number }) {
  const [current, setCurrent] = React.useState(() => now ?? Date.now())

  React.useEffect(() => {
    if (now !== undefined) return
    setCurrent(Date.now())
    const timer = window.setInterval(() => setCurrent(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [now, startedAt])

  return React.createElement(
    'span',
    { className: 'cv-running-duration' },
    `正在运行 · 已运行 ${runningDurationLabel(current - startedAt)}`,
  )
}

export function DeliveryDuration({ kind, durationMs }: { kind: DeliveryKind; durationMs?: number }) {
  if ((kind !== 'dev' && kind !== 'rework' && kind !== 'review') || !Number.isFinite(durationMs)) return null
  return React.createElement('span', { className: 'cv-tl-duration' }, `耗时 ${deliveryDurationLabel(durationMs ?? 0)}`)
}
