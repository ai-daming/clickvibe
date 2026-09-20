/** Read the host-owned visible session and its shared model directory. */
import { getClientContext } from './panel-state.ts'
export function currentAssessmentSession() {
  const ctx = getClientContext()
  const uiSession = ctx?.get('uiSession') as
    | { adapter?: { current?: { getSnapshot(): { key: string | undefined } } } }
    | undefined
  const current = uiSession?.adapter?.current
  if (!current?.getSnapshot) throw new Error('Harness 当前会话接口不可用，请检查 ClickVibe 与宿主版本')
  return current.getSnapshot().key
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
  if (!sessionId) throw new Error('请先在 Harness 打开对话，开发入口仍可使用')
  if (!directories?.directoryFor) throw new Error('Harness 模型选择接口不可用，请检查 ClickVibe 与宿主版本')
  const result = await directories.directoryFor(sessionId).load()
  if (!result.current || result.routable === false) throw new Error('请在 Harness 选择可用模型')
  return result.current
}
