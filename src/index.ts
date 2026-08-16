/**
 * dsh-deepseek-balance — host half. One route
 * (GET /api/dsh-deepseek-balance/balance) that returns the DeepSeek account
 * balance read with the same credential the `deepseek-official` LLM provider
 * uses (DEEPSEEK_API_KEY via the credentials seam, with a direct env
 * fallback). The browser half (./client) renders the badge left of the
 * composer model selector. No dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { BalanceEngine } from './engine.ts'
import { makeBalanceRoute } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'deepseek-balance'

/** Services required before the route can mount. */
export const inject = ['webServer', 'credentials']

/** Environment variable holding the DeepSeek key (dsh-llm-deepseek's default apiKeyEnv). */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (route). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Mount the balance route.
 * @param ctx - host plugin context carrying webServer and credentials.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  if (config?.enabled === false) return

  // Credentials is a declared inject requirement — accessing it without the
  // declaration aborts profile startup (cordis strict-service contract).
  const credentials = ctx.credentials

  const resolveKey = async (): Promise<string | undefined> => {
    try {
      const resolved = await credentials.resolve(credentialRef(DEEPSEEK_KEY_ENV))
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    } catch {
      // Fall through to the direct environment read.
    }
    const value = process.env[DEEPSEEK_KEY_ENV]
    return value === undefined || value === '' ? undefined : value
  }

  const engine = new BalanceEngine({ resolveKey })
  const route = makeBalanceRoute(engine)

  ctx.effect(
    () => {
      const dispose = ctx.webServer.register(route)
      return () => {
        dispose()
      }
    },
    'deepseek-balance: route',
  )
}
