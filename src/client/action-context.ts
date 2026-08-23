/**
 * 唯一动作「附加说明」输入框的纯状态判定(issue #54)。
 *
 * 交互规则来自验收标准,抽成纯函数(参照 panel-layout.ts 的可测模式):
 * - 返工(rework)首次展开时预填当前 review 意见,可编辑,发送以输入框
 *   最终文本为准;用户已输入的内容不覆盖;
 * - 动作成功触发后清空并折叠,避免残留文本被下一次动作误带;
 * - 实际发送内容为去首尾空白后的文本,空串即不随请求携带。
 */

/** 附加说明输入框的完整 UI 状态。 */
export interface ActionContextState {
  open: boolean
  text: string
}

/**
 * 展开/折叠切换后的输入框状态。返工首次展开(当前为空)且存在未通过的
 * review 意见时预填意见;其余动作与折叠方向一律保持原文不动。
 */
export function toggledContext(
  state: ActionContextState,
  actionKind: string,
  reviewIssues: string[] | null,
): ActionContextState {
  const open = !state.open
  if (open && actionKind === 'rework' && state.text === '' && reviewIssues !== null && reviewIssues.length > 0) {
    return { open, text: reviewIssues.join('\n') }
  }
  return { open, text: state.text }
}

/** 动作成功触发后的输入框状态:清空并折叠,残留文本不得进入下一次动作。 */
export function clearedContext(): ActionContextState {
  return { open: false, text: '' }
}

/** 动作触发时随 `context` 发送的内容;空串表示不携带,行为与现状一致。 */
export function contextToSubmit(text: string): string {
  return text.trim()
}
