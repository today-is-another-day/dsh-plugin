/**
 * Browser-half entry for the dsh-deepseek-balance plugin — runs inside the
 * dsh web GUI. Mounts the balance badge next to the composer model selector.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BalanceApi } from './api.ts'
import { mountBalanceBadge } from './badge.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject: string[] = []

/** Client-only exported types (no value exports beyond the plugin contract). */
export type { BalanceReadResult } from './api.ts'

/**
 * Mount the balance badge.
 * @param ctx - client root context (used for effect-scoped disposal).
 */
export function apply(ctx: ClientContext): void {
  const api = new BalanceApi()
  let dispose: (() => void) | undefined
  try {
    dispose = mountBalanceBadge(api)
  } catch (error) {
    // DOM failures degrade the badge, never the GUI.
    console.warn('[dsh-deepseek-balance] mount failed:', error)
  }
  ctx.effect(
    () => () => {
      dispose?.()
    },
    'deepseek-balance: badge',
  )
}
