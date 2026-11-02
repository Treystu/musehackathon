import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { handleIntent } from '../../functions/api/muse/intent'

/**
 * Server wait-out (2026-11-01): the intent route retries the flap
 * classes inside the request and records one breaker outcome per
 * route request. Timing is injected at ~0 here; production uses
 * DEFAULT_WAIT_OUT (gate waits out a 40 s breaker window, provider
 * retries at 8 s / 20 s).
 */
const INTENT: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const REQ = {
  method: 'POST',
  path: '/api/muse/intent',
  body: { queryText: 'rent in Hilo', slots: {} },
  clientId: 'c1',
}

function downError() {
  return Object.assign(new Error('down'), { code: 'provider_down' })
}

describe('intent route wait-out', () => {
  it('a provider that recovers inside the retry schedule answers 200', async () => {
    let calls = 0
    const meter = new Meter(defaultMeterConfig())
    const d = {
      meter,
      provider: createStubProvider({
        async intent() {
          calls += 1
          if (calls < 3) throw downError()
          return { intent: INTENT }
        },
      }),
      allowedModels: ['muse-spark-1.3'],
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] },
    }
    const r = await handleIntent(REQ, d)
    expect(r.status).toBe(200)
    expect(calls).toBe(3)
    // One route request, one outcome: the breaker never counted the
    // two recovered attempts (a success settles and resets anyway).
    expect(meter.snapshot().requests).toBe(1)
  })

  it('exhaustion returns provider_down after the full schedule, one failure recorded', async () => {
    let calls = 0
    const meter = new Meter(defaultMeterConfig())
    const d = {
      meter,
      provider: createStubProvider({
        async intent() {
          calls += 1
          throw downError()
        },
      }),
      allowedModels: ['muse-spark-1.3'],
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] },
    }
    const r = await handleIntent(REQ, d)
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('provider_down')
    expect(calls).toBe(3)
    // Exactly one consecutive failure on the meter for the whole
    // request: 4 more identical requests would be needed to trip it.
    for (let i = 0; i < 3; i += 1) {
      await handleIntent(REQ, d)
    }
    expect(meter.breakerState()).toBe('closed')
  })

  it('a non-flap error class is not retried', async () => {
    let calls = 0
    const d = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider({
        async intent() {
          calls += 1
          throw Object.assign(new Error('no credits'), { code: 'credits_exhausted' })
        },
      }),
      allowedModels: ['muse-spark-1.3'],
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] },
    }
    const r = await handleIntent(REQ, d)
    expect(r.status).toBe(429)
    expect(calls).toBe(1)
  })
})
