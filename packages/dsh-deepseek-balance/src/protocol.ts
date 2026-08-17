/**
 * Wire shapes shared by the host route and the browser half.
 *
 * Amounts travel as strings (already rounded to two decimals by the engine)
 * so the browser never re-formats floating-point noise. The API key never
 * appears in any of these shapes.
 */

/** Classified failure kinds the badge renders as distinct tooltip text. */
export type BalanceErrorKind =
  | 'missing_key'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'unknown'

/** One successful DeepSeek balance read (values are 2-decimal strings). */
export interface BalanceSnapshot {
  /** ISO 4217 currency code, e.g. `CNY`. */
  currency: string
  /** Total usable balance. */
  total: string
  /** Recharged (paid) portion. */
  toppedUp: string
  /** Granted (promotional) portion. */
  granted: string
  /** DeepSeek's `is_available` flag — false means the balance exists but API calls are blocked. */
  isAvailable: boolean
  /** Epoch milliseconds of the upstream read. */
  updatedAt: number
}

/** Classified failure with a user-facing (zh) message. */
export interface BalanceError {
  kind: BalanceErrorKind
  message: string
}

/** HTTP body shape of GET /api/dsh-deepseek-balance/balance. */
export interface BalanceHttpResponse {
  data?: BalanceSnapshot
  error?: BalanceError
}
