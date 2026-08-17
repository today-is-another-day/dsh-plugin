/**
 * The /api/dsh-deepseek-balance route: one exact GET endpoint that returns
 * the cached DeepSeek balance. Carries the same loopback-only trust fence
 * (plus browser same-origin markers) as the dsh-ssh route family, so a
 * LAN-exposed dsh web deployment does not serve account data to the LAN.
 * The route never reads or returns the API key.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { BalanceEngine, BalanceError } from './engine.ts'
import type { BalanceErrorKind } from './protocol.ts'

/** Exact route path the browser half polls. */
export const BALANCE_ROUTE_PATH = '/api/dsh-deepseek-balance/balance'

/** Loopback literal check plus browser same-origin markers (dsh-ssh fence). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response (never cached by intermediaries). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** HTTP status per failure kind. */
const STATUS: Record<BalanceErrorKind, number> = {
  missing_key: 424,
  auth: 401,
  rate_limited: 429,
  timeout: 504,
  network: 502,
  unknown: 500,
}

/**
 * Build the balance route.
 * @param engine - the balance engine the route reads through.
 */
export function makeBalanceRoute(engine: BalanceEngine): WebRoute {
  return {
    kind: 'exact',
    path: BALANCE_ROUTE_PATH,
    handler: async (req, res): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: { kind: 'auth', message: 'forbidden: loopback-only' } })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: { kind: 'unknown', message: 'method not allowed' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      try {
        const snapshot = await engine.refresh(force)
        writeJson(res, 200, { data: snapshot })
      } catch (error) {
        if (error instanceof BalanceError) {
          writeJson(res, STATUS[error.kind], { error: { kind: error.kind, message: error.message } })
          return
        }
        const message = error instanceof Error ? error.message : '未知错误'
        writeJson(res, 500, { error: { kind: 'unknown', message } })
      }
    },
  }
}
