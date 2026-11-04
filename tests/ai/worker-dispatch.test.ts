/**
 * Hermetic proof of the advanced-mode dispatch glue (tools/worker-entry.ts).
 * Drives dispatchFetch with a fake ASSETS binding: the live wrangler-dev
 * curl proof lives in the deploy-fix report, and this file pins the same
 * four behaviors so a refactor of the glue cannot silently reroute a path.
 */
import { describe, expect, it } from 'vitest'
import { dispatchFetch, type WorkerEnv } from '../../tools/worker-entry'
import { MeterDurableObject } from '../../functions/api/muse/meter-do'
import { resetMeterForTests } from '../../src/server/muse-adapter'

const APP_HTML =
  '<html><head><title>CivicScope</title></head><body><div id="root"></div></body></html>'

function fakeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ASSETS: {
      fetch: async () =>
        new Response(APP_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
    ...overrides,
  } as WorkerEnv
}

const exec = { waitUntil: () => {} }

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://portal.example${path}`, init)
}

describe('advanced-mode worker dispatch', () => {
  it('serves the app shell through the middleware when no Census key is set', async () => {
    const res = await dispatchFetch(req('/'), fakeEnv(), exec)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<div id="root">')
    expect(body).not.toContain('__CIVICSCOPE_SHARED_APP_KEYS__')
  })

  it('injects the shared-key script tag when CENSUS_APP_KEY is bound', async () => {
    const res = await dispatchFetch(req('/'), fakeEnv({ CENSUS_APP_KEY: 'testfake123' }), exec)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<script src="/shared-app-keys.js"></script>')
    // The key itself never rides the HTML: the CSP refuses inline
    // scripts, so the assignment is served from the script route.
    expect(body).not.toContain('testfake123')
  })

  it('serves the shared-key slot assignment from the script route', async () => {
    const res = await dispatchFetch(
      req('/shared-app-keys.js'),
      fakeEnv({ CENSUS_APP_KEY: 'testfake123' }),
      exec,
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('__CIVICSCOPE_SHARED_APP_KEYS__')
    expect(body).toContain('testfake123')
  })

  it('routes GET /api/muse/diagnostics to the diagnostics handler', async () => {
    const res = await dispatchFetch(req('/api/muse/diagnostics'), fakeEnv(), exec)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // No METER binding in the fake env: the env-derived claim is isolate.
    expect(body.meterPersistence).toBe('isolate')
    expect(body.sharedKeyPresent).toBe(false)
  })

  it('answers a keyless POST /api/muse/intent with the provider_down shape', async () => {
    const res = await dispatchFetch(
      req('/api/muse/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryText: 'rent in Pahoa' }),
      }),
      fakeEnv(),
      exec,
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'provider_down', detail: 'no shared key configured' })
  })

  it('refuses a matched route with the wrong method as 405 not_allowlisted', async () => {
    const res = await dispatchFetch(req('/api/muse/intent'), fakeEnv(), exec)
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: 'not_allowlisted' })
  })

  it('falls through to the asset server for an /api/ path no module owns', async () => {
    const res = await dispatchFetch(req('/api/muse/nope'), fakeEnv(), exec)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })
})

/* ------------------------------------------------------------------ */
/* K4 settle gap (scenario-coverage seat, 2026-11-03): the production  */
/* dispatch shape end to end. The functions-layer pins drive the       */
/* handlers directly with a fake meter; the deployed path adds the     */
/* worker-entry dispatch, the adapter's meter singleton, the real      */
/* DurableMeterClient protocol, and the real MeterDurableObject class  */
/* over storage. This pin drives exactly that shape: a METER namespace */
/* whose stub is the real class over a Map, a plan early-refusal       */
/* (which awaits its bookend settle), then a diagnostics read through  */
/* the same dispatch. If any seam in the chain drops the settle, the   */
/* last-settle read stays null here the way it did live.               */
/* ------------------------------------------------------------------ */

function fakeMeterNamespace() {
  const store = new Map<string, unknown>()
  const object = new MeterDurableObject(
    {
      storage: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          store.set(key, value)
        },
      },
    },
    {},
  )
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (input: string, init?: { method?: string; body?: string }) =>
        object.fetch(new Request(input, init)),
    }),
  }
}

describe('worker dispatch: bookend settle through the production shape (K4)', () => {
  it('a plan early-refusal settle lands in the durable mirror and diagnostics reads it back', async () => {
    resetMeterForTests()
    const env = fakeEnv({
      METER: fakeMeterNamespace() as unknown as WorkerEnv['METER'],
      MUSE_API_KEY: 'sk-test',
    })
    const planRes = await dispatchFetch(
      req('/api/muse/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
      exec,
    )
    // The invalid body is refused — and the refusal path awaits its
    // ('degraded', 'skipped') settle before replying.
    expect(planRes.status).toBe(400)

    const diagRes = await dispatchFetch(req('/api/muse/diagnostics'), env, exec)
    expect(diagRes.status).toBe(200)
    const body = (await diagRes.json()) as {
      meterPersistence: string
      usage: { readable: boolean }
      hourglass: { top: Record<string, number> }
      hourglassLastSettle: { top: { settle: string } | null }
    }
    expect(body.meterPersistence).toBe('durable')
    expect(body.usage.readable).toBe(true)
    expect(body.hourglass.top.degraded).toBe(1)
    expect(body.hourglassLastSettle.top?.settle).toBe('skipped')
    resetMeterForTests()
  })
})
