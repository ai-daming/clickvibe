/** In-process serialization for one workflow's read-modify-write operations. */
const workflowQueues = new Map<string, Promise<void>>()

export async function withWorkflowLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = workflowQueues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  workflowQueues.set(key, tail)
  try {
    return await result
  } finally {
    if (workflowQueues.get(key) === tail) workflowQueues.delete(key)
  }
}

/** Acquire multiple workflow locks in stable order to avoid cross-workflow deadlocks. */
export async function withWorkflowLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const unique = [...new Set(keys)].sort()
  const acquire = async (index: number): Promise<T> => {
    if (index >= unique.length) return operation()
    return withWorkflowLock(unique[index], () => acquire(index + 1))
  }
  return acquire(0)
}
