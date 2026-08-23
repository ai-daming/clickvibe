import type { WorkflowEvent } from '../infra/state.ts'

/** A review verdict closes one round; all work until the next verdict shares the next round. */
export function deriveEventRound(events: WorkflowEvent[]): number {
  return events.filter((event) => event.kind === 'review' && event.verdict !== undefined).length + 1
}

/** Resume deliveries are development facts too and must advance the reviewed-HEAD projection. */
export function latestDevelopmentHash(events: WorkflowEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.hash !== undefined && (event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume'),
    )?.hash
}

/** Keep event classification aligned with the existing develop-prompt context contract. */
export function deriveDevelopmentEventKind(firstDevelopment: boolean, extraContext: string): 'dev' | 'rework' {
  return !firstDevelopment && extraContext !== '' ? 'rework' : 'dev'
}
