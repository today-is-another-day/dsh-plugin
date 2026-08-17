/**
 * Balance engine: the framework-free core that talks to DeepSeek's official
 * balance endpoint (GET https://api.deepseek.com/user/balance).
 *
 * - In-memory cache with a short TTL (default 10s, matching the badge's
 *   10s polling cadence).
 * - In-flight coalescing: concurrent refreshes share one upstream call.
 * - Per-request key resolution (a changed credential reaches the next
 *   operation without any restart), with a hard timeout per upstream call.
 * - Every failure is classified; the API key is never logged and never
 *   included in error text (defensive redaction against echo).
 */

import type { BalanceErrorKind, BalanceSnapshot } from './protocol.ts'

/** Official balance endpoint. */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Default cache TTL (badge polls every 10s, so this makes upstream ~6 calls/min). */
export const DEFAULT_TTL_MS = 10_000
/** Default upstream timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Classified balance failure. */
export class BalanceError extends Error {
  constructor(
    public readonly kind: BalanceErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'BalanceError'
  }
}

/** Engine construction knobs (tests inject fetch, clock, and key source). */
export interface EngineOptions {
  /** Resolve the DeepSeek API key per call; undefined while unconfigured. */
  resolveKey: () => Promise<string | undefined>
  /** Fetch implementation (tests inject a mock). */
  fetchImpl?: typeof fetch
  /** Monotonic clock (tests inject a fake). */
  now?: () => number
  /** Cache TTL in ms. */
  ttlMs?: number
  /** Upstream timeout in ms. */
  timeoutMs?: number
}

/** Raw DeepSeek balance response shapes (numeric values arrive as strings on the wire). */
interface RawBalanceInfo {
  currency?: unknown
  total_balance?: unknown
  granted_balance?: unknown
  topped_up_balance?: unknown
}
interface RawBalanceResponse {
  is_available?: unknown
  balance_infos?: unknown
}

/** Coerce a wire value (number or numeric string) with a finite fallback. */
function toNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(num) ? num : fallback
}

/** Money string: always two decimals. */
function money(value: number): string {
  return value.toFixed(2)
}

/** Classify a fetch rejection (timeouts arrive as AbortError/TimeoutError). */
function classifyFetchError(error: unknown): BalanceError {
  const name = (error as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new BalanceError('timeout', '查询 DeepSeek 余额超时，请稍后重试。')
  }
  return new BalanceError('network', '网络错误，无法访问 DeepSeek 余额接口。')
}

/** Redact the key from any echoed text and cap the length. */
function sanitize(text: string, key: string): string {
  const replaced = key === '' ? text : text.split(key).join('[redacted]')
  return replaced.length > 300 ? replaced.slice(0, 300) : replaced
}

/**
 * The balance engine. Pure logic, no cordis dependency — unit-testable.
 */
export class BalanceEngine {
  private readonly resolveKey: () => Promise<string | undefined>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private cache: { snapshot: BalanceSnapshot; at: number } | undefined
  private inflight: Promise<BalanceSnapshot> | undefined

  constructor(options: EngineOptions) {
    this.resolveKey = options.resolveKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Read the balance: cached value when fresh, otherwise one upstream call
   * (shared across concurrent callers). `force` bypasses the cache.
   */
  async refresh(force = false): Promise<BalanceSnapshot> {
    const now = this.now()
    if (!force && this.cache !== undefined && now - this.cache.at < this.ttlMs) {
      return this.cache.snapshot
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async fetchOnce(): Promise<BalanceSnapshot> {
    const key = (await this.resolveKey())?.trim()
    if (key === undefined || key === '') {
      throw new BalanceError('missing_key', '未配置 DEEPSEEK_API_KEY，请在环境变量或 ~/.dsh 凭据来源中配置。')
    }
    let response: Response
    try {
      response = await this.fetchImpl(DEEPSEEK_BALANCE_URL, {
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw classifyFetchError(error)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = sanitize(await response.text(), key).trim()
      } catch {
        detail = ''
      }
      const suffix = detail === '' ? '' : `（${detail}）`
      if (response.status === 401 || response.status === 403) {
        throw new BalanceError('auth', `DeepSeek 拒绝访问（HTTP ${response.status}），请检查 API Key 是否有效。${suffix}`)
      }
      if (response.status === 429) {
        throw new BalanceError('rate_limited', 'DeepSeek 接口限流，请稍后重试。')
      }
      throw new BalanceError('unknown', `DeepSeek 余额接口返回异常（HTTP ${response.status}）。${suffix}`)
    }
    let raw: RawBalanceResponse
    try {
      raw = (await response.json()) as RawBalanceResponse
    } catch {
      throw new BalanceError('unknown', 'DeepSeek 余额响应不是合法 JSON。')
    }
    const infos = Array.isArray(raw.balance_infos) ? (raw.balance_infos as RawBalanceInfo[]) : []
    if (infos.length === 0) {
      throw new BalanceError('unknown', 'DeepSeek 余额响应缺少 balance_infos。')
    }
    // Prefer CNY (the account's home currency), else the first entry.
    const picked = infos.find(info => typeof info.currency === 'string' && info.currency.toUpperCase() === 'CNY') ?? infos[0]
    if (picked === undefined) {
      throw new BalanceError('unknown', 'DeepSeek 余额响应缺少 balance_infos。')
    }
    const snapshot: BalanceSnapshot = {
      currency: typeof picked.currency === 'string' ? picked.currency : 'CNY',
      total: money(toNumber(picked.total_balance, 0)),
      toppedUp: money(toNumber(picked.topped_up_balance, 0)),
      granted: money(toNumber(picked.granted_balance, 0)),
      isAvailable: raw.is_available !== false,
      updatedAt: this.now(),
    }
    this.cache = { snapshot, at: snapshot.updatedAt }
    return snapshot
  }
}
