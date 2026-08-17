/**
 * Browser-side API client for the host balance route. The only data access
 * path the badge uses — plain fetch, same origin.
 */

import type { BalanceHttpResponse } from '../protocol.ts'

/** Result of one read: exactly one of `data` / `error` is present. */
export interface BalanceReadResult {
  data?: BalanceHttpResponse['data']
  error?: BalanceHttpResponse['error']
}

/** The browser half's only data entry point. */
export class BalanceApi {
  /** Read the balance; `force` bypasses the host-side cache. */
  async balance(force: boolean): Promise<BalanceReadResult> {
    const query = force ? '?force=1' : ''
    let response: Response
    try {
      response = await fetch(`/api/dsh-deepseek-balance/balance${query}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
    } catch {
      return { error: { kind: 'network', message: '无法连接本机 dsh 服务。' } }
    }
    let body: BalanceHttpResponse
    try {
      body = (await response.json()) as BalanceHttpResponse
    } catch {
      return { error: { kind: 'unknown', message: `响应异常（HTTP ${response.status}）。` } }
    }
    if (response.ok && body.data !== undefined) return { data: body.data }
    if (body.error !== undefined) return { error: body.error }
    return { error: { kind: 'unknown', message: `响应异常（HTTP ${response.status}）。` } }
  }
}
