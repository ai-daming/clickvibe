/**
 * Package-owned invariant companion for `clickvibe`.
 * @module clickvibe/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    invariants: {
      register(packageName: string, installer: () => void): () => void
    }
  }
}

const PACKAGE_NAME = 'clickvibe'

/** Cordis companion plugin name. */
export const name = 'clickvibe-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns no service state or event protocol —
 * the /clickvibe/api route is mounted under the host's webServer and the
 * gh-call contract is exercised through the shell seam. The route fence and
 * shell semantics are each observed through their seams.
 */
const install: () => void = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
