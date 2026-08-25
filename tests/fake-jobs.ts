interface FakeJobHooks {
  cancel(reason?: string): void
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
}

interface FakeJobStart {
  kind: string
  label: string
  run(): FakeJobHooks
}

interface FakeJobRecord {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  startedAt: number
  reported: boolean
  hooks: FakeJobHooks
}

/** Minimal programmable implementation of the real jobs seam for route tests. */
export function createFakeJobs() {
  const records = new Map<string, FakeJobRecord>()
  let sequence = 0
  const snapshot = ({ hooks: _hooks, ...record }: FakeJobRecord) => ({ ...record })
  return {
    attachController() {},
    list() {
      return [...records.values()].map(snapshot)
    },
    get(id: string) {
      const record = records.get(String(id))
      if (!record) throw new Error(`unknown job ${id}`)
      return snapshot(record)
    },
    start(spec: FakeJobStart) {
      const hooks = spec.run()
      const id = `${spec.kind}-${++sequence}`
      const record: FakeJobRecord = {
        id,
        kind: spec.kind,
        label: spec.label,
        status: 'running',
        startedAt: Date.now(),
        reported: false,
        hooks,
      }
      records.set(id, record)
      void hooks.done.then(
        (outcome) => {
          record.status = outcome.status
        },
        () => {
          record.status = 'failed'
        },
      )
      return id
    },
    kill(id: string, _caller?: unknown, reason?: string) {
      const record = records.get(String(id))
      if (!record) throw new Error(`unknown job ${id}`)
      if (record.status !== 'running' && record.status !== 'stopping') return 'already-finished' as const
      record.status = 'stopping'
      record.hooks.cancel(reason)
      return 'requested' as const
    },
  }
}
