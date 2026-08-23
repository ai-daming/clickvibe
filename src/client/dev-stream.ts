/** Disk-history hydration and SSE lifecycle for the development view. */
import React from 'react'
import type { Workflow } from './domain.ts'
import { decodeLiveLogLine, selectHistoryTask, type LiveLogEvent } from './runtime.ts'

type HistoryResponse =
  | {
      ok: true
      taskId: string | null
      key: string
      kind: 'dev' | 'review'
      lines: string[]
      events?: LiveLogEvent[]
      cursor: number
      active: boolean
    }
  | { ok: false; error: string }

export function useDevStream(workflow: Workflow | null, refresh: () => Promise<void>) {
  const [logEvents, setLogEvents] = React.useState<LiveLogEvent[]>([])
  const [historyKind, setHistoryKind] = React.useState<'dev' | 'review' | null>(null)
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null)
  const [streamState, setStreamState] = React.useState<
    'idle' | 'history' | 'connecting' | 'streaming' | 'retrying' | 'ended'
  >('idle')
  const [streamNotice, setStreamNotice] = React.useState<string | null>(null)
  const esRef = React.useRef<EventSource | null>(null)
  const streamGenerationRef = React.useRef(0)
  const checkingStreamRef = React.useRef(false)

  const appendLogEvent = (event: LiveLogEvent) => {
    setLogEvents((previous) => [...previous, event])
  }
  const fetchHistory = async (taskId: string): Promise<HistoryResponse> => {
    const response = await fetch(`/clickvibe/api/history?taskId=${encodeURIComponent(taskId)}`)
    return response.json() as Promise<HistoryResponse>
  }

  // 磁盘历史是基线;只有 /history 返回的 cursor 之后才接 SSE 增量。
  const openStream = async (taskId: string, expectRunning = true) => {
    const generation = ++streamGenerationRef.current
    setActiveTaskId(taskId)
    setStreamState('history')
    setStreamNotice(null)
    esRef.current?.close()
    setLogEvents([])
    setHistoryKind(null)

    let history: HistoryResponse
    try {
      history = await fetchHistory(taskId)
    } catch {
      if (generation !== streamGenerationRef.current) return
      setStreamState('retrying')
      setStreamNotice('历史加载失败,正在等待网络恢复…')
      window.setTimeout(() => {
        if (generation === streamGenerationRef.current) void openStream(taskId, expectRunning)
      }, 1500)
      return
    }
    if (generation !== streamGenerationRef.current) return
    if (!history.ok) {
      setActiveTaskId(null)
      setStreamState('ended')
      setStreamNotice('任务已结束/中断')
      if (expectRunning) void refresh()
      return
    }

    setHistoryKind(history.kind)
    setLogEvents(history.events ?? history.lines.map(decodeLiveLogLine))
    if (!history.active) {
      setActiveTaskId(null)
      setStreamState(expectRunning ? 'ended' : 'idle')
      setStreamNotice(expectRunning ? '任务已结束/中断' : null)
      if (expectRunning) void refresh()
      return
    }

    setStreamState('connecting')
    const es = new EventSource(`/clickvibe/api/stream?taskId=${encodeURIComponent(taskId)}&cursor=${history.cursor}`)
    esRef.current = es
    es.onopen = () => {
      if (generation === streamGenerationRef.current) setStreamState('streaming')
    }
    es.onmessage = (event) => {
      if (generation !== streamGenerationRef.current) return
      try {
        const data = JSON.parse(event.data) as
          | string
          | { __done?: boolean; __historyRequired?: boolean; line?: string; event?: LiveLogEvent; cursor?: number }
        if (typeof data === 'object' && data.__done) {
          es.close()
          setActiveTaskId(null)
          setStreamState('ended')
          void refresh()
          return
        }
        if (typeof data === 'object' && data.__historyRequired) {
          es.close()
          void openStream(taskId, true)
          return
        }
        appendLogEvent(
          typeof data === 'object' && data.event
            ? data.event
            : decodeLiveLogLine(typeof data === 'object' && typeof data.line === 'string' ? data.line : String(data)),
        )
      } catch {
        appendLogEvent(decodeLiveLogLine(event.data))
      }
    }
    es.onerror = () => {
      if (generation !== streamGenerationRef.current || checkingStreamRef.current) return
      setStreamState('retrying')
      checkingStreamRef.current = true
      // EventSource hides HTTP status. Re-read the authoritative task target:
      // active means native EventSource retry should continue; inactive/404 is
      // terminal and must clear the stop control instead of failing silently.
      void fetchHistory(taskId)
        .then((latest) => {
          if (generation !== streamGenerationRef.current) return
          if (latest.ok && latest.active) return
          es.close()
          setActiveTaskId(null)
          setStreamState('ended')
          setStreamNotice('任务已结束/中断')
          void refresh()
        })
        .catch(() => {
          // Network outage: leave EventSource open so its built-in retry survives
          // phone network switches and temporary Host unreachability.
        })
        .finally(() => {
          checkingStreamRef.current = false
        })
    }
  }

  React.useEffect(
    () => () => {
      streamGenerationRef.current += 1
      esRef.current?.close()
    },
    [],
  )

  // 恢复现场:完成态也加载最后一次磁盘历史;进行态再接 SSE。
  React.useEffect(() => {
    if (!workflow) return
    const { taskId, expectRunning } = selectHistoryTask({
      stage: workflow.stage,
      devTaskId: workflow.devTaskId,
      reviewTaskId: workflow.reviewTaskId,
      hasReviewResult: Boolean(workflow.reviewResult),
    })
    if (taskId) void openStream(taskId, expectRunning)
  }, [workflow?.devTaskId, workflow?.reviewTaskId, workflow?.stage])

  return {
    activeTaskId,
    historyKind,
    logEvents,
    openStream,
    setHistoryKind,
    setLogEvents,
    streamNotice,
    streamState,
  }
}
