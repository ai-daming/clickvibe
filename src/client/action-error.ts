import type { Workflow } from './domain.ts'

type DerivedStatus = NonNullable<Workflow['derived']>['status']

const EXPIRED_REVIEW_GATE_FRAGMENTS = [
  '尚未完成开发',
  '开发尚未完成',
  '开发仍在进行,尚无可 Review 的完成事实',
  '尚无完成事实,无法 Review',
]

/** Identify a review gate error invalidated by newer derived workflow facts. */
export function isActionErrorExpired(
  error: string | null,
  status: DerivedStatus | undefined,
  busy: string | null,
): boolean {
  if (busy !== null || (status !== 'review-ready' && status !== 'reviewing')) return false
  return error !== null && EXPIRED_REVIEW_GATE_FRAGMENTS.some((fragment) => error.includes(fragment))
}
