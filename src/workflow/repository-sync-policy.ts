/** Pure repository-level advance signal and safe-sync decisions. */
import type { GitCompare } from '../infra/git.ts'

export interface RepositorySyncPolicyInput {
  defaultBranch: string
  checkoutBranch: string | null
  dirty: boolean | null
  main: GitCompare | null
  checkout: GitCompare | null
}

export interface RepositoryAdvanceInput extends Omit<RepositorySyncPolicyInput, 'dirty'> {}

export interface RepositoryAdvance {
  defaultBranch: string
  remoteRef: string
  mainBehind: number | null
  checkoutBranch: string | null
  checkoutBehind: number | null
}

export type CheckoutSyncDecision = 'unchanged' | 'fast-forward' | 'merge' | 'dirty' | 'detached' | 'unavailable'

export type MainSyncDecision = 'unchanged' | 'fast-forward' | 'diverged' | 'checked-out' | 'unavailable'

export function deriveRepositoryAdvance(input: RepositoryAdvanceInput): RepositoryAdvance {
  return {
    defaultBranch: input.defaultBranch,
    remoteRef: `origin/${input.defaultBranch}`,
    mainBehind: input.main?.behind ?? null,
    checkoutBranch: input.checkoutBranch,
    checkoutBehind:
      input.checkoutBranch === null || input.checkoutBranch === input.defaultBranch
        ? null
        : (input.checkout?.behind ?? null),
  }
}

export function decideRepositorySync(input: RepositorySyncPolicyInput): {
  checkout: CheckoutSyncDecision
  main: MainSyncDecision
} {
  let checkout: CheckoutSyncDecision
  if (input.checkoutBranch === null) checkout = 'detached'
  else if (input.dirty === null || input.checkout === null) checkout = 'unavailable'
  else if (input.dirty) checkout = 'dirty'
  else if (input.checkout.behind === 0) checkout = 'unchanged'
  else if (input.checkout.ahead === 0) checkout = 'fast-forward'
  else checkout = 'merge'

  let main: MainSyncDecision
  if (input.checkoutBranch === 'main') main = 'checked-out'
  else if (input.main === null) main = 'unavailable'
  else if (input.main.behind === 0) main = 'unchanged'
  else if (input.main.ahead === 0) main = 'fast-forward'
  else main = 'diverged'
  return { checkout, main }
}
