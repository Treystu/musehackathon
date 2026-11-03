import { describe, expect, it } from 'vitest'
import { dispatchFetch, type WorkerEnv } from '../../tools/worker-entry'

/**
 * Registration pins for the conversational stack's server routes
 * (C2/C3/C5): a route that exists in functions/ but not in the
 * worker map answers 405 or falls through to assets — the
 * 2026-11-01 lesson, pinned. Keyless env: each route must answer
 * its own typed shape, which only its real handler produces.
 */
function fakeEnv(): WorkerEnv {
  return {
    ASSETS: {
      fetch: async () =>
        new Response('<html><body>app</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
  } as WorkerEnv
}

const exec = { waitUntil: () => {} }

function post(path: string, body: unknown): Request {
  return new Request(`https://portal.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('server stack route registration', () => {
  it('POST /api/muse/jev reaches the jev handler: typed unavailable without a key', async () => {
    const res = await dispatchFetch(post('/api/muse/jev', { set: 'J-PHRASE', state: {} }), fakeEnv(), exec)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'jev_unavailable' })
  })

  it('POST /api/muse/plan reaches the plan handler: keyless provider_down shape', async () => {
    const res = await dispatchFetch(post('/api/muse/plan', {}), fakeEnv(), exec)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'provider_down',
      detail: 'no shared key configured',
    })
  })

  it('POST /api/muse/verify reaches the verify handler: keyless provider_down shape', async () => {
    const res = await dispatchFetch(post('/api/muse/verify', {}), fakeEnv(), exec)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'provider_down',
      detail: 'no shared key configured',
    })
  })

  it('POST /api/muse/flexible reaches the flexible handler: keyless provider_down shape', async () => {
    const res = await dispatchFetch(post('/api/muse/flexible', {}), fakeEnv(), exec)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'provider_down',
      detail: 'no shared key configured',
    })
  })

  it('GET on the new POST routes is the 405 not_allowlisted shape', async () => {
    for (const path of ['/api/muse/jev', '/api/muse/plan', '/api/muse/verify', '/api/muse/flexible']) {
      const res = await dispatchFetch(
        new Request(`https://portal.example${path}`),
        fakeEnv(),
        exec,
      )
      expect(res.status).toBe(405)
      expect(await res.json()).toEqual({ error: 'not_allowlisted' })
    }
  })

  it('diagnostics carries the additive hourglass counters', async () => {
    const res = await dispatchFetch(
      new Request('https://portal.example/api/muse/diagnostics'),
      fakeEnv(),
      exec,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hourglass?: unknown }
    expect(body.hourglass).toEqual({
      top: { sound: expect.any(Number), unsound: expect.any(Number), degraded: expect.any(Number) },
      bottom: { verified: expect.any(Number), concerns: expect.any(Number), notRun: expect.any(Number) },
    })
  })
})
