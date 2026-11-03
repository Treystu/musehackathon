import { beforeEach, describe, expect, it } from 'vitest'
import { handleDiagnostics } from '../../functions/api/muse/diagnostics'
import {
  MeterDurableObject,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
} from '../../functions/api/muse/meter-do'
import {
  meterFor,
  resetMeterForTests,
  type MuseEnv,
} from '../../src/server/muse-adapter'

const SECRET = 'sk-live-SENTINEL-route-never-echoed'

/**
 * A METER binding backed by one in-memory Durable Object (the
 * meter-do.test.ts harness pattern), so a test env can carry the
 * portal's durable meter without a Workers runtime.
 */
function fakeMeterNamespace(): DurableObjectNamespaceLike {
  const map = new Map<string, unknown>()
  const storage: DurableObjectStorageLike = {
    async get<T>(key: string): Promise<T | undefined> {
      const v = map.get(key)
      return v === undefined ? undefined : (structuredClone(v) as T)
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value))
    },
  }
  const state: DurableObjectStateLike = { storage }
  const doObj = new MeterDurableObject(state)
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (input, init) => doObj.fetch(new Request(input, init)),
    }),
  }
}

function context(
  env: MuseEnv,
  init: { method?: string; origin?: string } = {},
): Parameters<typeof handleDiagnostics>[0] {
  return {
    request: new Request('https://app.test/api/muse/diagnostics', {
      method: init.method ?? 'GET',
      headers: init.origin ? { origin: init.origin } : undefined,
    }),
    env,
    params: {},
    next: async () => new Response(null, { status: 404 }),
    waitUntil: () => {},
  }
}

describe('GET /api/muse/diagnostics', () => {
  beforeEach(() => {
    resetMeterForTests()
  })

  it('exposes the last-bookend attribution beside the aggregate counts (K4)', async () => {
    const { recordTopBookend, resetBookendCountersForTests } =
      await import('../../src/core/ai/bookend-counters')
    resetBookendCountersForTests()
    const res = await handleDiagnostics(context({}))
    const body = (await res.json()) as {
      hourglassLastSettle?: { top: unknown; bottom: unknown }
    }
    // Before any settle on this isolate, both entries are null —
    // the attribution signal itself (R21 F4).
    expect(body.hourglassLastSettle).toEqual({ top: null, bottom: null })
    recordTopBookend('sound')
    const res2 = await handleDiagnostics(context({}))
    const body2 = (await res2.json()) as {
      hourglassLastSettle?: {
        top: { settle: string; outcome: string; at: string } | null
        bottom: unknown
      }
    }
    expect(body2.hourglassLastSettle?.top?.settle).toBe('settled-ok')
    expect(body2.hourglassLastSettle?.top?.outcome).toBe('sound')
    expect(Number.isNaN(Date.parse(body2.hourglassLastSettle?.top?.at ?? ''))).toBe(false)
    expect(body2.hourglassLastSettle?.bottom).toBeNull()
    resetBookendCountersForTests()
  })

  it('reports a configured key as a boolean and never echoes the key', async () => {
    // The portal env: key set + METER binding present, so the durable
    // persistence report is earned by the binding, not hard-coded.
    const response = await handleDiagnostics(
      context({ MUSE_API_KEY: SECRET, METER: fakeMeterNamespace() }),
    )
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('MUSE_API_KEY')
    const body = JSON.parse(text)
    expect(body.sharedKeyPresent).toBe(true)
    expect(body.modelIsDefault).toBe(true)
    expect(body.perClientCap).toBe('unset')
    expect(body.meterPersistence).toBe('durable')
    expect(body.budgetCapMicroUsd).toBe(52_500_000)
  })

  it('reports an absent key without inventing one', async () => {
    const response = await handleDiagnostics(context({}))
    const body = await response.json()
    expect(body.sharedKeyPresent).toBe(false)
    expect(body.modelIsDefault).toBe(true)
    // No METER binding in this env: the in-isolate meter is the truth.
    expect(body.meterPersistence).toBe('isolate')
  })

  it('reports whether a per-client cap is configured without publishing its value', async () => {
    const response = await handleDiagnostics(
      context({ MUSE_API_KEY: 'test-key', MUSE_PER_CLIENT_CAP_MICRO_USD: '1234567' }),
    )
    const text = await response.text()
    const body = JSON.parse(text)
    expect(body.perClientCap).toBe('configured')
    expect(text).not.toContain('1234567')
    expect(text).not.toContain('perClientCapMicroUsd')
  })

  it('refuses a foreign origin and a non-GET method', async () => {
    const foreign = await handleDiagnostics(context({}, { origin: 'https://evil.example' }))
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toEqual({ error: 'not_allowlisted' })

    const post = await handleDiagnostics(context({}, { method: 'POST' }))
    expect(post.status).toBe(405)
  })

  it('exports only allowlisted error classes, dropping arbitrary recorded names', async () => {
    const env: MuseEnv = {}
    const meter = meterFor(env)
    meter.recordError('invented_numeral')
    meter.recordError(SECRET)

    const response = await handleDiagnostics(context(env))
    const text = await response.text()
    const body = JSON.parse(text)
    expect(body.errors.invented_numeral).toBe(1)
    expect(body.errors).not.toHaveProperty(SECRET)
    expect(text).not.toContain(SECRET)
  })

  it('accepts platform build identity only in platform shapes', async () => {
    const valid = await handleDiagnostics(
      context({
        CF_PAGES: '1',
        CF_PAGES_BRANCH: 'submission',
        CF_PAGES_COMMIT_SHA: 'd4a7dc66d618967171bac3807771d4a5cef20589',
      }),
    )
    const validBody = await valid.json()
    expect(validBody.deployment).toEqual({
      pages: true,
      branch: 'submission',
      commit: 'd4a7dc66d618967171bac3807771d4a5cef20589',
    })

    resetMeterForTests()
    const invalid = await handleDiagnostics(
      context({
        CF_PAGES_BRANCH: 'lane/submission with prose',
        CF_PAGES_COMMIT_SHA: 'not a commit',
      }),
    )
    const invalidBody = await invalid.json()
    expect(invalidBody.deployment.branch).toBeNull()
    expect(invalidBody.deployment.commit).toBeNull()
    expect(invalidBody.deployment.pages).toBe(false)
  })
})
