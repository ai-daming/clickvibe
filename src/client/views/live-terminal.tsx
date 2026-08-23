import { formatElapsed, latestTokenUsage, taskStartedAt, type LiveLogEvent } from '../runtime.ts'
/** Live and detached terminal presentation for one agent task. */
import React from 'react'
import { createPortal } from 'react-dom'

export function LiveTerminal({
  events,
  taskId,
  active,
  streamState,
  agent: fallbackAgent,
}: {
  events: LiveLogEvent[]
  taskId: string | null
  active: boolean
  streamState: 'idle' | 'history' | 'connecting' | 'streaming' | 'retrying' | 'ended'
  agent?: 'codex' | 'claude' | null
}) {
  const [detached, setDetached] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const logRef = React.useRef<HTMLDivElement | null>(null)
  const startedAt = taskStartedAt(taskId)
  const usage = latestTokenUsage(events)
  const agent = [...events].reverse().find((event) => event.agent)?.agent ?? fallbackAgent ?? undefined

  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, taskId])

  React.useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [events.length, detached, streamState])

  React.useEffect(() => {
    if (!detached) return
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetached(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = priorOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [detached])

  const tokenLabel = usage
    ? `tokens ${usage.totalTokens?.toLocaleString() ?? '?'}${usage.inputTokens !== undefined || usage.outputTokens !== undefined ? ` · in ${usage.inputTokens?.toLocaleString() ?? '?'} / out ${usage.outputTokens?.toLocaleString() ?? '?'}` : ''}`
    : null
  const stateLabel =
    streamState === 'retrying' ? '重连中' : streamState === 'history' ? '恢复历史' : active ? 'LIVE' : '已结束'

  const terminal = (
    <div className="cv-terminal" data-agent={agent ?? undefined}>
      <div className="cv-terminal-head">
        <span aria-hidden="true">●</span>
        <span className="cv-terminal-agent" data-agent={agent ?? undefined}>
          {agent ?? 'agent'}
        </span>
        <span>{stateLabel}</span>
        {active && startedAt !== null ? (
          <span aria-label="任务已运行时长">{formatElapsed(now - startedAt)}</span>
        ) : null}
        {tokenLabel ? <span>{tokenLabel}</span> : null}
        <span className="cv-terminal-spacer" />
        <button
          type="button"
          className="cv-terminal-detach"
          aria-label={detached ? '收回实时输出' : '放大实时输出'}
          title={detached ? '收回(Esc)' : '放大查看'}
          onClick={() => setDetached((value) => !value)}
        >
          {detached ? '↙ 收回' : '↗ 放大'}
        </button>
      </div>
      <div className="cv-dev-log" ref={logRef} role="log" aria-live="polite" aria-label="实时输出">
        {events
          .filter((event) => event.kind !== 'usage')
          .map((event, index) => (
            <div
              key={index}
              className={`cv-terminal-line cv-terminal-line-${event.source === 'system' ? 'system' : event.kind}`}
            >
              {event.text}
            </div>
          ))}
        {events.length === 0 ? (
          <div className="cv-terminal-line">{streamState === 'history' ? '正在恢复历史…' : '等待 agent 输出…'}</div>
        ) : null}
        {streamState === 'retrying' ? (
          <div className="cv-terminal-line cv-terminal-line-system">[clickvibe] 连接中断,正在自动重连…</div>
        ) : null}
      </div>
    </div>
  )

  return detached
    ? createPortal(
        <div className="cv-terminal-overlay" role="dialog" aria-modal="true" aria-label="放大的实时输出">
          {terminal}
        </div>,
        document.body,
      )
    : terminal
}
