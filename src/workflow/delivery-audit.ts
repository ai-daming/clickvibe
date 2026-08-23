import type { WorkflowEvent } from '../infra/state.ts'

/** A review verdict closes one round; all work until the next verdict shares the next round. */
export function deriveEventRound(events: WorkflowEvent[], _kind: WorkflowEvent['kind']): number {
  return events.filter((event) => event.kind === 'review' && event.verdict !== undefined).length + 1
}
