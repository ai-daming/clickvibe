import type { Workflow } from './domain.ts'

type DerivedStatus = NonNullable<Workflow['derived']>['status']

/** Identify a review gate error invalidated by newer derived workflow facts. */
export function isActionErrorExpired(
  error: string | null,
  status: DerivedStatus | undefined,
  busy: string | null,
): boolean {
  if (busy !== null || (status !== 'review-ready' && status !== 'reviewing')) return false
  return error !== null && /(?:尚未完成开发|开发尚未完成)/.test(error)
}
