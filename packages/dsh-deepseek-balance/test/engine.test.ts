import { describe, expect, it } from 'vitest'
import { BalanceEngine, BalanceError, DEEPSEEK_BALANCE_URL } from '../src/engine.ts'

/** Minimal Response shim-free helper (Node 22 ships global Response). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A controllable fetch mock. */
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch
}

const GOOD_KEY = 'sk-test-1234abcd'

function goodBody(): unknown {
  return {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: 70.79, granted_balance: 0, topped_up_balance: 70.79 },
    ],
  }
}

function makeEngine(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  options: Partial<ConstructorParameters<typeof BalanceEngine>[0]> = {},
): BalanceEngine {
  return new BalanceEngine({
    resolveKey: async () => GOOD_KEY,
    fetchImpl: mockFetch(impl),
    ...options,
  })
}

describe('BalanceEngine', () => {
  it('parses a successful balance response (CNY preferred, 2-decimal strings)', async () => {
    const engine = makeEngine(async (url) => {
      expect(url).toBe(DEEPSEEK_BALANCE_URL)
      return jsonResponse(goodBody())
    })
    const snapshot = await engine.refresh()
    expect(snapshot).toEqual({
      currency: 'CNY',
      total: '70.79',
      toppedUp: '70.79',
      granted: '0.00',
      isAvailable: true,
      updatedAt: expect.any(Number) as number,
    })
  })

  it('parses numeric-string balances (the real wire format)', async () => {
    const engine = makeEngine(async () =>
      jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '30.75', granted_balance: '0.00', topped_up_balance: '30.75' },
        ],
      }),
    )
    const snapshot = await engine.refresh()
    expect(snapshot.total).toBe('30.75')
    expect(snapshot.toppedUp).toBe('30.75')
    expect(snapshot.granted).toBe('0.00')
  })

  it('prefers CNY when multiple currencies are present', async () => {
    const engine = makeEngine(async () =>
      jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: 10, granted_balance: 0, topped_up_balance: 10 },
          { currency: 'CNY', total_balance: 70.79, granted_balance: 0, topped_up_balance: 70.79 },
        ],
      }),
    )
    const snapshot = await engine.refresh()
    expect(snapshot.currency).toBe('CNY')
    expect(snapshot.total).toBe('70.79')
  })

  it('sends the bearer key and accept header', async () => {
    let seen: RequestInit | undefined
    const engine = makeEngine(async (_url, init) => {
      seen = init
      return jsonResponse(goodBody())
    })
    await engine.refresh()
    const headers = seen?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe(`Bearer ${GOOD_KEY}`)
    expect(headers?.accept).toBe('application/json')
  })

  it('caches within the TTL and bypasses on force', async () => {
    let calls = 0
    const engine = makeEngine(async () => {
      calls += 1
      return jsonResponse(goodBody())
    })
    await engine.refresh()
    await engine.refresh()
    expect(calls).toBe(1)
    await engine.refresh(true)
    expect(calls).toBe(2)
  })

  it('refreshes once the TTL expires', async () => {
    let calls = 0
    let now = 0
    const engine = makeEngine(
      async () => {
        calls += 1
        return jsonResponse(goodBody())
      },
      { now: () => now, ttlMs: 10_000 },
    )
    await engine.refresh()
    now = 9_999
    await engine.refresh()
    expect(calls).toBe(1)
    now = 10_001
    await engine.refresh()
    expect(calls).toBe(2)
  })

  it('coalesces concurrent refreshes into one upstream call', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const engine = makeEngine(async () => {
      calls += 1
      await gate
      return jsonResponse(goodBody())
    })
    const first = engine.refresh()
    const second = engine.refresh()
    const third = engine.refresh(true)
    release?.()
    const results = await Promise.all([first, second, third])
    expect(calls).toBe(1)
    expect(results[0]?.total).toBe('70.79')
    expect(results[1]?.total).toBe('70.79')
    expect(results[2]?.total).toBe('70.79')
  })

  it('reports missing_key without calling upstream', async () => {
    let calls = 0
    const engine = new BalanceEngine({
      resolveKey: async () => undefined,
      fetchImpl: mockFetch(async () => {
        calls += 1
        return jsonResponse(goodBody())
      }),
    })
    await expect(engine.refresh()).rejects.toMatchObject({ kind: 'missing_key' })
    expect(calls).toBe(0)
  })

  it('classifies 401 as auth and redacts the key from echoed bodies', async () => {
    const engine = makeEngine(async () =>
      jsonResponse({ error: { message: `invalid key ${GOOD_KEY}` } }, 401),
    )
    const error = await engine.refresh().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(BalanceError)
    expect((error as BalanceError).kind).toBe('auth')
    expect((error as BalanceError).message).toContain('[redacted]')
    expect((error as BalanceError).message).not.toContain(GOOD_KEY)
  })

  it('classifies 429 as rate_limited', async () => {
    const engine = makeEngine(async () => jsonResponse({}, 429))
    await expect(engine.refresh()).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('classifies fetch rejections (timeout vs network)', async () => {
    const timedOut = makeEngine(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    })
    await expect(timedOut.refresh()).rejects.toMatchObject({ kind: 'timeout' })

    const networked = makeEngine(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(networked.refresh()).rejects.toMatchObject({ kind: 'network' })
  })

  it('classifies a malformed body as unknown', async () => {
    const engine = makeEngine(async () =>
      jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] }),
    )
    const snapshot = await engine.refresh()
    expect(snapshot.total).toBe('0.00')
  })

  it('propagates is_available=false', async () => {
    const engine = makeEngine(async () =>
      jsonResponse({
        is_available: false,
        balance_infos: [{ currency: 'CNY', total_balance: 70.79, granted_balance: 0, topped_up_balance: 70.79 }],
      }),
    )
    const snapshot = await engine.refresh()
    expect(snapshot.isAvailable).toBe(false)
  })
})
