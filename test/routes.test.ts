import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BalanceEngine } from '../src/engine.ts'
import { BALANCE_ROUTE_PATH, makeBalanceRoute } from '../src/routes.ts'

const GOOD_KEY = 'sk-test-1234abcd'

/** Fake request with a controllable remote address / headers. */
function makeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  const base = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    method: 'GET',
    url: BALANCE_ROUTE_PATH,
  }
  return { ...base, ...overrides } as unknown as IncomingMessage
}

/** Fake response capturing status/headers/body. */
function makeRes(): {
  res: ServerResponse
  readonly status: number | undefined
  readonly headers: Record<string, unknown> | undefined
  readonly body: string
} {
  const captured: { status: number | undefined; headers: Record<string, unknown> | undefined; body: string } = {
    status: undefined,
    headers: undefined,
    body: '',
  }
  const res = {
    writeHead: (status: number, headers: Record<string, unknown>) => {
      captured.status = status
      captured.headers = headers
      return res
    },
    end: (payload: string) => {
      captured.body = payload
      return res
    },
  } as unknown as ServerResponse
  return {
    res,
    get status() {
      return captured.status
    },
    get headers() {
      return captured.headers
    },
    get body() {
      return captured.body
    },
  }
}

function goodEngine(): BalanceEngine {
  return new BalanceEngine({
    resolveKey: async () => GOOD_KEY,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: 70.79, granted_balance: 0, topped_up_balance: 70.79 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  })
}

describe('balance route', () => {
  it('serves the balance for a loopback browser request', async () => {
    const route = makeBalanceRoute(goodEngine())
    const captured = makeRes()
    await route.handler(makeReq(), captured.res)
    expect(captured.status).toBe(200)
    const parsed = JSON.parse(captured.body) as { data: { total: string; currency: string } }
    expect(parsed.data?.total).toBe('70.79')
    expect(parsed.data?.currency).toBe('CNY')
  })

  it('rejects non-loopback remote addresses with 403', async () => {
    const route = makeBalanceRoute(goodEngine())
    const captured = makeRes()
    await route.handler(makeReq({ socket: { remoteAddress: '192.168.1.10' } }), captured.res)
    expect(captured.status).toBe(403)
    expect(JSON.parse(captured.body)).toMatchObject({ error: { kind: 'auth' } })
  })

  it('rejects cross-site fetch markers', async () => {
    const route = makeBalanceRoute(goodEngine())
    const captured = makeRes()
    await route.handler(makeReq({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), captured.res)
    expect(captured.status).toBe(403)
  })

  it('rejects non-GET methods with 405', async () => {
    const route = makeBalanceRoute(goodEngine())
    const captured = makeRes()
    await route.handler(makeReq({ method: 'POST' }), captured.res)
    expect(captured.status).toBe(405)
  })

  it('maps engine failures to status codes without leaking the key', async () => {
    const engine = new BalanceEngine({
      resolveKey: async () => GOOD_KEY,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: `bad key ${GOOD_KEY}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    const route = makeBalanceRoute(engine)
    const captured = makeRes()
    await route.handler(makeReq(), captured.res)
    expect(captured.status).toBe(401)
    expect(captured.body).toContain('[redacted]')
    expect(captured.body).not.toContain(GOOD_KEY)
    expect(JSON.parse(captured.body)).toMatchObject({ error: { kind: 'auth' } })
  })

  it('passes the force query flag through to the engine', async () => {
    const engine = goodEngine()
    const spy = vi.spyOn(engine, 'refresh')
    const route = makeBalanceRoute(engine)
    const captured = makeRes()
    await route.handler(makeReq({ url: `${BALANCE_ROUTE_PATH}?force=1` }), captured.res)
    expect(spy).toHaveBeenCalledWith(true)
  })

  it('maps a missing key to 424', async () => {
    const engine = new BalanceEngine({
      resolveKey: async () => undefined,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    })
    const route = makeBalanceRoute(engine)
    const captured = makeRes()
    await route.handler(makeReq(), captured.res)
    expect(captured.status).toBe(424)
    expect(JSON.parse(captured.body)).toMatchObject({ error: { kind: 'missing_key' } })
  })
})
