import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import { handleExplain } from '../../functions/api/muse/explain'

const VALUES = [{ key: 'median_gross_rent', value: 1200, marginOfError: 50 }]

function deps(handler: Partial<MuseProvider> = {}) {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(handler),
    allowedModels: ['spark-test'],
    // Taxonomy tests: production wait-out timing would stall them.
    waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
  }
}

function req(body: unknown) {
  return { method: 'POST', path: '/api/muse/explain', body, clientId: 'c1' }
}

describe('explain route', () => {
  it('rejects missing or malformed shapes before reserving', async () => {
    const d = deps()
    const cases: unknown[] = [
      {},
      { values: VALUES },
      { figureSetId: '', values: VALUES },
      { figureSetId: 'f1', values: 'not-an-array' },
      { figureSetId: 'f1', values: [{ key: 'x' }] },
      { figureSetId: 'f1', values: [{ key: 'x', value: '1200' }] },
      { figureSetId: 'f1', values: [{ key: 'x', value: 1200, marginOfError: 'wide' }] },
      {
        figureSetId: 'f1',
        values: Array.from({ length: 25 }, () => ({ key: 'x', value: 1 })),
      },
    ]
    for (const body of cases) {
      const r = await handleExplain(req(body), d)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.error).toBe('shape_invalid')
    }
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('rejects unknown figure keys and extra value fields before reserving', async () => {
    const d = deps()
    const unknown = await handleExplain(
      req({ figureSetId: 'f1', values: [{ key: 'fabricated_metric', value: 999 }] }),
      d,
    )
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('shape_invalid')

    const extra = await handleExplain(
      req({ figureSetId: 'f1', values: [{ key: 'median_gross_rent', value: 1200, source: 'x' }] }),
      d,
    )
    expect(extra.status).toBe(400)
    expect(extra.body.error).toBe('shape_invalid')

    const unknownDerived = await handleExplain(
      req({ figureSetId: 'f1', values: [{ key: 'derived:unknown_metric', value: 1 }] }),
      d,
    )
    expect(unknownDerived.status).toBe(400)
    expect(unknownDerived.body.error).toBe('shape_invalid')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('accepts a code-supplied derived figure key', async () => {
    const d = deps({
      async explain() {
        return { prose: 'The renter share is 42 percent.' }
      },
    })
    const r = await handleExplain(
      req({ figureSetId: 'f1', values: [{ key: 'derived:renter_pct', value: 42 }] }),
      d,
    )
    expect(r.status).toBe(200)
    expect(r.body.prose).toContain('42')
  })

  it('returns validated prose and settles the meter', async () => {
    const d = deps({
      async explain() {
        return { prose: 'The median gross rent is 1,200, plus or minus 50.' }
      },
    })
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.prose).toContain('1,200')
    expect(r.body.withheld).toBeUndefined()
    const snap = d.meter.snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.spentMicroUsd).toBeGreaterThan(0)
    expect(snap.tokensOut).toBeGreaterThan(0)
  })

  it('withholds prose that fails numeral provenance', async () => {
    const d = deps({
      async explain() {
        return { prose: 'The median gross rent is 9999.' }
      },
    })
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('invented_numeral')
    expect(r.body.prose).toBeUndefined()
    expect(d.meter.snapshot().requests).toBe(1)
    expect(d.meter.snapshot().errors.invented_numeral).toBe(1)
  })

  it('withholds ranking language even when the figures match', async () => {
    const d = deps({
      async explain() {
        return { prose: 'This is the best area; the median gross rent is 1,200.' }
      },
    })
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('banned_construction')
  })

  it('maps provider failures onto the closed taxonomy and releases the reservation', async () => {
    const d = deps({
      async explain() {
        throw Object.assign(new Error('rl'), { code: 'rate_limited' })
      },
    })
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate_limited')
    expect(d.meter.snapshot().requests).toBe(0)
    expect(d.meter.snapshot().errors.rate_limited).toBe(1)
  })

  it('maps a bad key to 401', async () => {
    const d = deps({
      async explain() {
        throw Object.assign(new Error('bad'), { code: 'bad_key' })
      },
    })
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('bad_key')
  })

  it('rejects a non-allowlisted model before the provider call', async () => {
    const d = deps()
    const r = await handleExplain(
      req({ figureSetId: 'f1', values: VALUES, model: 'other-model' }),
      d,
    )
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_allowlisted')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('rejects an open breaker when the wait-out budget is zero', async () => {
    // Production deps wait out the cooldown (DEFAULT_WAIT_OUT); a zero
    // budget keeps the rejection semantics pinned without a 40 s test.
    const d = {
      ...deps(),
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [] as number[] },
    }
    for (let i = 0; i < defaultMeterConfig().breakerFailureThreshold; i += 1) {
      d.meter.recordFailure()
    }
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('breaker_open')
  })

  it('waits out an open breaker that lifts, then serves the call', async () => {
    // Short cooldown: the breaker reads half-open ~30 ms after opening,
    // inside the gate's wait budget, so the call is served instead of
    // rejected — the production behavior at a 30 s cooldown.
    const meter = new Meter({ ...defaultMeterConfig(), breakerCooldownMs: 30 })
    const d = {
      meter,
      provider: createStubProvider({
        async explain() {
          return { prose: 'Rent is $1,200 here.' }
        },
      }),
      allowedModels: ['spark-test'],
      waitOut: { breakerWaitMs: 5_000, pollMs: 1, retryDelaysMs: [] as number[] },
    }
    for (let i = 0; i < defaultMeterConfig().breakerFailureThreshold; i += 1) {
      meter.recordFailure()
    }
    expect(meter.breakerState()).toBe('open')
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
  })

  it('returns budget_exhausted after the cap is settled', async () => {
    const meter = new Meter({ ...defaultMeterConfig(), budgetCapMicroUsd: 100 })
    const id = meter.reserve('c1', 100, 10)
    expect(id).not.toBeNull()
    meter.settle(id as string, 'c1', 100, 10, 10)
    const d = { meter, provider: createStubProvider(), allowedModels: ['spark-test'] }
    const r = await handleExplain(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('budget_exhausted')
  })
})
