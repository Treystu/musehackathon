import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import { verifyFigureSet } from '../../src/core/ai/briefing'
import { handleBriefing } from '../../functions/api/muse/briefing'

const VALUES = [
  { key: 'median_gross_rent', value: 1200, marginOfError: 50, vintage: '2023' },
  { key: 'median_rent_burden_pct', value: 31.5 },
]

function deps(handler: Partial<MuseProvider> = {}) {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(handler),
    allowedModels: ['spark-test'],
  }
}

function req(body: unknown) {
  return { method: 'POST', path: '/api/muse/briefing', body, clientId: 'c1' }
}

describe('briefing route shape discipline', () => {
  it('rejects missing or malformed shapes before reserving', async () => {
    const d = deps()
    const cases: unknown[] = [
      {},
      { values: VALUES },
      { figureSetId: '', values: VALUES },
      { figureSetId: 'f1', values: 'not-an-array' },
      { figureSetId: 'f1', values: [{ key: 'x' }] },
      { figureSetId: 'f1', values: [{ key: 'median_gross_rent', value: '1200' }] },
      { figureSetId: 'f1', values: [{ key: 'median_gross_rent', value: 1200, vintage: 2023 }] },
      { figureSetId: 'f1', values: [{ key: 'fabricated_metric', value: 999 }] },
      { figureSetId: 'f1', values: [{ key: 'median_gross_rent', value: 1200, source: 'x' }] },
      {
        figureSetId: 'f1',
        values: Array.from({ length: 25 }, () => ({ key: 'median_gross_rent', value: 1 })),
      },
    ]
    for (const body of cases) {
      const r = await handleBriefing(req(body), d)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.error).toBe('shape_invalid')
    }
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('rejects a non-allowlisted model before the provider call', async () => {
    const d = deps()
    const r = await handleBriefing(
      req({ figureSetId: 'f1', values: VALUES, model: 'other-model' }),
      d,
    )
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_allowlisted')
    expect(d.meter.snapshot().requests).toBe(0)
  })
})

describe('briefing pack composition: source re-verification', () => {
  it('fails loudly on a tampered percent figure and never calls the provider', async () => {
    let called = false
    const d = deps({
      async briefing() {
        called = true
        return { prose: 'unreachable' }
      },
    })
    const r = await handleBriefing(
      req({
        figureSetId: 'f1',
        values: [{ key: 'median_rent_burden_pct', value: 140 }],
      }),
      d,
    )
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('shape_invalid')
    expect(String(r.body.detail)).toContain('median_rent_burden_pct')
    expect(called).toBe(false)
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('fails loudly on conflicting values for the same figure key', async () => {
    const d = deps()
    const r = await handleBriefing(
      req({
        figureSetId: 'f1',
        values: [
          { key: 'median_gross_rent', value: 1200 },
          { key: 'median_gross_rent', value: 1250 },
        ],
      }),
      d,
    )
    expect(r.status).toBe(422)
    expect(String(r.body.detail)).toContain('median_gross_rent')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('fails loudly on a suppressed small-count figure', async () => {
    const d = deps()
    const r = await handleBriefing(
      req({ figureSetId: 'f1', values: [{ key: 'households', value: 12 }] }),
      d,
    )
    expect(r.status).toBe(422)
    expect(String(r.body.detail)).toContain('households')
  })

  it('fails loudly on a figure with no value and on a negative median', async () => {
    const d = deps()
    const noValue = await handleBriefing(
      req({ figureSetId: 'f1', values: [{ key: 'median_home_value', value: null }] }),
      d,
    )
    expect(noValue.status).toBe(422)
    const negative = await handleBriefing(
      req({ figureSetId: 'f1', values: [{ key: 'median_home_value', value: -5 }] }),
      d,
    )
    expect(negative.status).toBe(422)
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('verifyFigureSet passes a clean set in order and accepts known derived figures', () => {
    const clean = verifyFigureSet(VALUES)
    expect(clean.ok).toBe(true)
    if (clean.ok) {
      expect(clean.figures.map((f) => f.key)).toEqual([
        'median_gross_rent',
        'median_rent_burden_pct',
      ])
    }
    const derived = verifyFigureSet([{ key: 'derived:renter_pct', value: 42 }])
    expect(derived.ok).toBe(true)
    const derivedTampered = verifyFigureSet([{ key: 'derived:renter_pct', value: 142 }])
    expect(derivedTampered.ok).toBe(false)
  })

  it('verifyFigureSet rejects bad vintages and negative margins of error', () => {
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, vintage: '23' }]).ok,
    ).toBe(false)
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, vintage: '1880' }]).ok,
    ).toBe(false)
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, marginOfError: -1 }]).ok,
    ).toBe(false)
  })
})

describe('briefing route generation', () => {
  it('returns validated prose over the verified set and settles the meter', async () => {
    const d = deps({
      async briefing(request) {
        expect(request.values).toHaveLength(2)
        expect(request.values[0]?.value).toBe(1200)
        return { prose: 'The median gross rent is 1,200, plus or minus 50.' }
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
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
      async briefing() {
        return { prose: 'The median gross rent is 9999.' }
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('invented_numeral')
    expect(r.body.prose).toBeUndefined()
    expect(d.meter.snapshot().errors.invented_numeral).toBe(1)
  })

  it('withholds ranking language even when the figures match', async () => {
    const d = deps({
      async briefing() {
        return { prose: 'This is the best area; the median gross rent is 1,200.' }
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('banned_construction')
  })

  it('maps provider failures onto the closed taxonomy and releases the reservation', async () => {
    const d = deps({
      async briefing() {
        throw Object.assign(new Error('rl'), { code: 'rate_limited' })
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate_limited')
    expect(d.meter.snapshot().requests).toBe(0)
    expect(d.meter.snapshot().errors.rate_limited).toBe(1)
  })

  it('maps a bad key to 401', async () => {
    const d = deps({
      async briefing() {
        throw Object.assign(new Error('bad'), { code: 'bad_key' })
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('bad_key')
  })

  it('rejects an open breaker', async () => {
    const d = deps()
    for (let i = 0; i < defaultMeterConfig().breakerFailureThreshold; i += 1) {
      d.meter.recordFailure()
    }
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('breaker_open')
  })

  it('returns budget_exhausted after the cap is settled', async () => {
    const meter = new Meter({ ...defaultMeterConfig(), budgetCapMicroUsd: 100 })
    const id = meter.reserve('c1', 100, 10)
    expect(id).not.toBeNull()
    meter.settle(id as string, 'c1', 100, 10, 10)
    const d = { meter, provider: createStubProvider(), allowedModels: ['spark-test'] }
    const r = await handleBriefing(req({ figureSetId: 'f1', values: VALUES }), d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('budget_exhausted')
  })
})
