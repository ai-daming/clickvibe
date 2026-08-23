import type { Context } from '@deepseek-ai/cordis'
import type { AutoRunTaskOutcome } from './auto-run-policy.ts'

type Reconciler = (ctx: Context, workflowKey: string, outcome?: AutoRunTaskOutcome) => void
let reconciler: Reconciler | null = null

export function registerAutoRunReconciler(value: Reconciler): void {
  reconciler = value
}

/** Completion notification is best-effort; durable workflow facts remain recoverable manually. */
export function notifyAutoRunCompletion(ctx: Context, workflowKey: string, outcome?: AutoRunTaskOutcome): void {
  reconciler?.(ctx, workflowKey, outcome)
}
