/**
 * Invalidation bus for Local Git Snapshots (issue #122). Deliberately
 * dependency-free so any layer — including infra adapters that import
 * runtime.ts — can broadcast a mutation without import cycles. Registries
 * register themselves at construction; broadcasts reach every live instance.
 */

export interface LocalGitMutationScope {
  repoKey: string
  /** When present, only this worktree's scope is invalidated; otherwise the whole repo. */
  worktreePath?: string | null
}

export interface LocalGitInvalidation {
  scope: string
  reason: string
  trigger: string
  at: number
}

export interface LocalGitSnapshotInvalidator {
  invalidate(scope: LocalGitMutationScope, reason: string, trigger: string): void
}

const liveRegistries = new Set<LocalGitSnapshotInvalidator>()

export function registerSnapshotRegistry(registry: LocalGitSnapshotInvalidator): void {
  liveRegistries.add(registry)
}

export function unregisterSnapshotRegistry(registry: LocalGitSnapshotInvalidator): void {
  liveRegistries.delete(registry)
}

/** Broadcast one local-git mutation to every live registry (ADR-0007 invalidation). */
export function notifyLocalGitMutation(scope: LocalGitMutationScope, reason: string, trigger: string): void {
  for (const registry of liveRegistries) {
    registry.invalidate(scope, reason, trigger)
  }
}
