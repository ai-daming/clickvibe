/**
 * Gateway owner (issue #131 slice A; ADR-0010 §1/§4).
 *
 * One credential scope owns one in-process Gateway runtime. v0.2 is
 * deliberately conservative about scope identity: the `gh` CLI host auth
 * cannot be safely split into distinct credentials from the Controller, so
 * everything shares a single scope — under-sharing reuse is acceptable,
 * splitting one budget never is (ADR-0010 Decision 1). Worktrees and Work
 * Items attribute calls; they never own Gateway state.
 *
 * The owner's first owned mechanism is the request lane, absorbed verbatim
 * from the former host-global symbol in rest.ts: promise-chain serialization
 * with a monotonic re-check so the minimum start interval is a guarantee.
 * Slice A later commits extend this owner with admission scheduling,
 * budgets, cache generations and the lifecycle stream — each arriving
 * together with its consumer (concept budget, AGENTS.md §2.5 principle 11).
 */

interface OwnerRequestLane {
  tail: Promise<void>
  nextStartAt: number
}

export interface GithubGatewayOwner {
  /** Opaque identity; never contains token material. */
  readonly credentialScopeId: string
  /** Serialize one HTTP step across the credential scope with a minimum start interval. */
  serializeRequest<T>(minimumIntervalMs: number, request: () => Promise<T>): Promise<T>
}

/** Conservative v0.2 scope: the host's gh auth is one credential. */
const CONSERVATIVE_CREDENTIAL_SCOPE = 'host-gh-auth:v1'

let owner: GithubGatewayOwner | null = null

export function githubGatewayOwner(): GithubGatewayOwner {
  if (owner) return owner
  const lane: OwnerRequestLane = { tail: Promise.resolve(), nextStartAt: 0 }
  owner = {
    credentialScopeId: CONSERVATIVE_CREDENTIAL_SCOPE,
    serializeRequest<T>(minimumIntervalMs: number, request: () => Promise<T>): Promise<T> {
      const previous = lane.tail
      let release = () => {}
      lane.tail = new Promise<void>((resolve) => {
        release = resolve
      })
      return (async () => {
        await previous
        try {
          // Timers may wake just before their requested deadline. Re-check the
          // monotonic wall-clock condition so the configured start interval is a
          // guarantee rather than a best-effort delay.
          while (Date.now() < lane.nextStartAt) {
            await new Promise((resolve) => setTimeout(resolve, lane.nextStartAt - Date.now()))
          }
          const pending = request()
          lane.nextStartAt = Date.now() + minimumIntervalMs
          return await pending
        } finally {
          release()
        }
      })()
    },
  }
  return owner
}
