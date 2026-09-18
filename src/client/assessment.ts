/** Browser assessment client; independent of development buttons and state. */
import React from 'react'
import { apiCall } from './domain.ts'
import { getClientContext, setPanelOpen } from './panel-state.ts'
import { openDshConversationDraft, resolveDshConversationDeps } from './dsh-conversation.ts'
export interface AssessmentItem {
  url: string
  id?: string
  phase?: string
  label: string
  discussion: boolean
  report?: { text: string; verdict: string } | null
  error?: string
  repoPath?: string
  publication?: { status: string; error?: string }
}
export async function assessmentCall<T = { ok: boolean; error?: string }>(body: Record<string, unknown>): Promise<T> {
  const result = await apiCall<T & { ok: boolean; error?: string }>('assessment', body)
  if (!result.ok) throw new Error(result.error ?? '评估请求失败')
  return result
}
export function currentAssessmentSession() {
  const ctx = getClientContext()
  const sessions = ctx?.get('sessions') as { list?: { getSnapshot(): { current?: string } } } | undefined
  return sessions?.list?.getSnapshot().current
}
export async function currentAssessmentModel() {
  const ctx = getClientContext()
  const sessionId = currentAssessmentSession()
  const directories = ctx?.get('modelDirectories') as
    | {
        directoryFor(id: string): {
          load(): Promise<{
            current: { provider: string; model: string; reasoningEffort?: string } | null
            routable: boolean | null
          }>
        }
      }
    | undefined
  if (!sessionId || !directories) throw new Error('请先在 Harness 打开对话并选择模型，开发入口仍可使用')
  const result = await directories.directoryFor(sessionId).load()
  if (!result.current || result.routable === false) throw new Error('请在 Harness 选择可用模型')
  return result.current
}
export function useAssessments(urls: string[]) {
  const [items, setItems] = React.useState<AssessmentItem[]>([])
  const [error, setError] = React.useState('')
  const key = [...new Set(urls.filter(Boolean))].sort().join('\n')
  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const selected = key ? key.split('\n') : []
    setItems([])
    setError('')
    async function load() {
      if (!selected.length) return
      try {
        const result = await assessmentCall<{ items: AssessmentItem[]; error?: string }>({
          action: 'status',
          urls: selected,
        })
        if (!disposed) {
          setItems(result.items)
          setError(result.error ?? '')
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      }
      if (!disposed) timer = setTimeout(load, 3000)
    }
    const refreshDiscussion = () => {
      void assessmentCall({ action: 'discussion-refresh', urls: selected }).catch((reason) => {
        if (!disposed) setError(String(reason))
      })
    }
    void load()
    refreshDiscussion()
    window.addEventListener('focus', refreshDiscussion)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('focus', refreshDiscussion)
    }
  }, [key])
  return { items, error }
}
export async function discussAssessment(item: AssessmentItem) {
  const ctx = getClientContext()
  if (!ctx || !item.repoPath || !item.id || !item.report) throw new Error('缺少评估讨论上下文')
  const deps = resolveDshConversationDeps(ctx)
  if ('missing' in deps) throw new Error(`Harness 缺少 ${deps.missing.join('、')}`)
  const draft = `请继续讨论这张 Issue：${item.url}\n以下是此前评估原文，建议不代表用户已确认：\n\n${item.report.text}\n\n讨论确认后使用“整理 Issue”更新原目标，不另建重复 Issue。`
  const result = await openDshConversationDraft(deps, item.repoPath, draft, async (sessionId) => {
    await assessmentCall({ action: 'discussion', id: item.id, sessionId })
  })
  if (!result.ok) throw new Error(result.error)
  if (result.warning) throw new Error(result.warning)
  setPanelOpen(false)
}

export function useProjectAssessments(urls: string[], repoKey: string, onError: (message: string) => void) {
  const state = useAssessments(urls)
  const key = urls.join('\n')
  React.useEffect(() => {
    const trigger = () => {
      if (repoKey && key)
        void assessmentCall({ action: 'automatic', repoKey, urls: key.split('\n') }).catch((reason) =>
          onError(String(reason)),
        )
    }
    trigger()
    const timer = setInterval(trigger, 15000)
    return () => clearInterval(timer)
  }, [repoKey, key])
  return state
}
