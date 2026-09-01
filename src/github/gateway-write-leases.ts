import { AsyncLocalStorage } from 'node:async_hooks'
import { GatewayClosedError } from './gateway-contracts.ts'

/**
 * Write-lease registry (ADR-0010 §9) — the owner's exclusive-write machinery,
 * extracted as a pure move + layering (issue #131 review F2 grew the
 * close/queue settlement past the 800-line hard limit of gateway-owner.ts).
 *
 * Leases are held as a set and granted whole from a FIFO queue, so two
 * overlapping write transactions can never deadlock or interleave; reads of
 * covered keys wait for release. The transaction's own authoritative
 * readback runs exempt — it must never queue behind its own lease. Queued
 * entries carry their logical request id so close() settles each with one
 * interrupted terminal instead of leaving an invisible waiter past the seal.
 */

export interface WriteLeaseHooks {
  /** Emit the single interrupted terminal for a queued write at close(). */
  noteInterruptedTerminal(requestId: string, error: Error): void
}

export interface WriteLeaseRegistry {
  /** Acquire the sorted key set atomically; resolve returns the release. */
  acquire(keys: string[], requestId: string): Promise<() => void>
  /** Wait until no held write lease covers this read key (child paths included). */
  waitReadable(key: string): Promise<void>
  /** Run a composition exempt from read-side lease waiting. */
  runExempt<T>(fn: () => Promise<T>): Promise<T>
  /** Reject every queued write and lease-blocked read. Each queued write
   *  leaves exactly one interrupted terminal through the hooks. */
  interruptAll(): void
  /** Queued writes plus lease-blocked reads — live work for quiescence. */
  pendingWaiters(): number
}

export function createWriteLeaseRegistry(hooks: WriteLeaseHooks): WriteLeaseRegistry {
  const heldWriteLeases = new Set<string>()
  const writeQueue: Array<{ keys: string[]; requestId: string; resolve: () => void; reject: (error: Error) => void }> =
    []
  const readableWaiters: Array<{ key: string; resolve: () => void; reject: (error: Error) => void }> = []
  const leaseExemptAls = new AsyncLocalStorage<boolean>()

  const coversKey = (readKey: string, leaseKey: string): boolean =>
    readKey === leaseKey || readKey.startsWith(`${leaseKey}/`)

  const pumpWriteQueue = () => {
    while (writeQueue.length > 0) {
      const head = writeQueue[0]
      if (head.keys.some((key) => heldWriteLeases.has(key))) break
      writeQueue.shift()
      for (const key of head.keys) heldWriteLeases.add(key)
      head.resolve()
    }
  }

  const notifyReadableWaiters = () => {
    const pending = readableWaiters.splice(0, readableWaiters.length)
    for (const waiter of pending) waiter.resolve()
  }

  return {
    acquire(keys: string[], requestId: string): Promise<() => void> {
      const sorted = [...new Set(keys)].sort()
      return new Promise((resolve, reject) => {
        writeQueue.push({
          keys: sorted,
          requestId,
          resolve: () => {
            resolve(() => {
              for (const key of sorted) heldWriteLeases.delete(key)
              pumpWriteQueue()
              notifyReadableWaiters()
            })
          },
          reject,
        })
        pumpWriteQueue()
      })
    },
    async waitReadable(key: string): Promise<void> {
      if (leaseExemptAls.getStore() === true) return
      for (;;) {
        const held = [...heldWriteLeases].some((leaseKey) => coversKey(key, leaseKey))
        if (!held) return
        await new Promise<void>((resolve, reject) => {
          readableWaiters.push({ key, resolve, reject })
        })
      }
    },
    runExempt<T>(fn: () => Promise<T>): Promise<T> {
      return leaseExemptAls.run(true, fn)
    },
    interruptAll(): void {
      for (const queued of writeQueue.splice(0)) {
        const error = new GatewayClosedError('Gateway 已关闭:排队写请求被中断')
        hooks.noteInterruptedTerminal(queued.requestId, error)
        queued.reject(error)
      }
      for (const waiter of readableWaiters.splice(0)) {
        waiter.reject(new GatewayClosedError('Gateway 已关闭:资源读等待被中断'))
      }
    },
    pendingWaiters(): number {
      return writeQueue.length + readableWaiters.length
    },
  }
}
