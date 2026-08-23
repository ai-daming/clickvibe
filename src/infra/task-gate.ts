/**
 * Synchronous per-key reservation for tasks that must not overlap.
 * JavaScript runs reserve() without an await boundary, so a second request
 * either observes the first reservation or replaces an already-closed task.
 */
export class ExclusiveTaskGate<T extends { closed: boolean }> {
  private readonly active = new Map<string, T>()

  reserve(key: string, create: () => T): { task: T; created: boolean } {
    const existing = this.active.get(key)
    if (existing && !existing.closed) return { task: existing, created: false }

    const task = create()
    this.active.set(key, task)
    return { task, created: true }
  }

  release(key: string, task: T): void {
    if (this.active.get(key) === task) this.active.delete(key)
  }
}
