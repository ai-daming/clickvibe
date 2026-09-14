/** Select only the output of the assessment's one completed input. */
export interface AssessmentEvent {
  type: string
  data: Record<string, unknown>
}
export function readAssessmentOutput(events: readonly AssessmentEvent[], messageId: string): string {
  const inputs = events.filter(
    (event) => event.type === 'user/message' && (event.data.source as { kind?: string } | undefined)?.kind === 'user',
  )
  if (inputs.length !== 1 || inputs[0].data.id !== messageId) throw new Error('评估会话输入归属不一致')
  const ends = events.filter((event) => event.type === 'turn/end')
  const end = ends.at(-1)
  if (
    !end ||
    (end.data.reason as { kind?: string })?.kind !== 'completed' ||
    !events.some((event) => event.type === 'step/start' && event.data.turn === end.data.turn)
  )
    throw new Error('评估尚未完整完成或已中断')
  if (
    events
      .slice(events.indexOf(end) + 1)
      .some(
        (event) =>
          event.type === 'turn/start' || (event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'),
      )
  )
    throw new Error('评估完成后仍有未完成输入')
  const assistant = events.filter((event) => event.type === 'assistant/message').at(-1)
  const content = (assistant?.data.message as { content?: unknown } | undefined)?.content as
    | { type: string; text?: string }[]
    | undefined
  const text = content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
  if (!text) throw new Error('评估完成但没有报告正文')
  return text
}
