import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { validateIntent, isFilterLegal } from '../../src/core/ai/intent-schema'
import { hermeticStubValidator } from '../../src/core/ai/validator'
import { createStubProvider } from '../../src/core/ai/provider'
import { handleIntent } from '../../functions/api/muse/intent'

describe('intent schema allowlist', () => {
  it('accepts a filter-legal sweep_filter', () => {
    const r = validateIntent({
      mode: 'sweep_filter',
      geographies: ['HI'],
      metricKeys: ['median_rent_burden_pct'],
      filters: [{ metricKey: 'median_rent_burden_pct', op: 'gt', value: 33.3 }],
      clarificationNeeded: false,
    })
    expect(r.ok).toBe(true)
  })

  it('blocks a non-filter-legal filter key (proxy/school surface)', () => {
    const r = validateIntent({
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_age'],
      filters: [{ metricKey: 'median_age', op: 'gt', value: 40 }],
      clarificationNeeded: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('proxy_metric_blocked')
  })

  it('rejects unknown metric keys outright', () => {
    const r = validateIntent({
      mode: 'lookup',
      geographies: [],
      metricKeys: ['not_a_real_metric'],
      filters: [],
      clarificationNeeded: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('not_allowlisted')
  })

  it('rejects malformed filter shapes instead of casting', () => {
    const base = {
      mode: 'sweep_filter',
      geographies: ['HI'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    const badFilters = [
      { metricKey: 'median_gross_rent', op: 'DROP', value: 1000 },
      { metricKey: 'median_gross_rent', op: 'gt', value: '1000' },
      { metricKey: 'median_gross_rent', op: 'gt', value: Number.NaN },
      { metricKey: 'median_gross_rent', op: 'gt', value: 1000, extra: true },
    ]
    for (const filter of badFilters) {
      const r = validateIntent({ ...base, filters: [filter] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('shape_invalid')
    }
    const proxy = validateIntent({
      ...base,
      filters: [{ metricKey: 'median_age', op: 'gt', value: 40 }],
    })
    expect(proxy.ok).toBe(false)
    if (!proxy.ok) expect(proxy.error).toBe('proxy_metric_blocked')
  })

  it('requires the declared arrays and a boolean clarification flag', () => {
    expect(
      validateIntent({ mode: 'lookup', metricKeys: [], filters: [], clarificationNeeded: false }).ok,
    ).toBe(false)
    expect(
      validateIntent({ mode: 'lookup', geographies: [], filters: [], clarificationNeeded: false }).ok,
    ).toBe(false)
    expect(
      validateIntent({ mode: 'lookup', geographies: [], metricKeys: [], filters: [] }).ok,
    ).toBe(false)
    expect(
      validateIntent({ mode: 'lookup', geographies: [''], metricKeys: [], filters: [], clarificationNeeded: false }).ok,
    ).toBe(false)
  })

  it('filter-legal set is the audited sortable set', () => {
    expect(isFilterLegal('median_gross_rent')).toBe(true)
    expect(isFilterLegal('median_age')).toBe(false)
  })
})

describe('meter', () => {
  it('enforces the budget cap and per-request ceiling', () => {
    const m = new Meter({ ...defaultMeterConfig(), budgetCapMicroUsd: 1500 })
    expect(m.reserve('c1', 1000, 100)).not.toBeNull()
    m.settle('r1', 'c1', 1000, 10, 10)
    expect(m.reserve('c1', 1000, 100)).toBeNull()
    expect(m.snapshot().budgetExhausted).toBe(false)
  })

  it('opens the breaker after repeated failures', () => {
    const m = new Meter({ ...defaultMeterConfig(), breakerFailureThreshold: 2 })
    m.recordFailure()
    m.recordFailure()
    expect(m.breakerState()).toBe('open')
  })

  it('enforces per-client cap when configured', () => {
    const m = new Meter({ ...defaultMeterConfig(), perClientCapMicroUsd: 500 })
    expect(m.reserve('c1', 600, 10)).toBeNull()
    expect(m.reserve('c1', 400, 10)).not.toBeNull()
  })

  it('counts outstanding reservations against the cap and never reuses a live id', () => {
    const m = new Meter({ ...defaultMeterConfig(), budgetCapMicroUsd: 1000 })
    const first = m.reserve('c1', 600, 10)
    expect(first).not.toBeNull()
    expect(m.reserve('c1', 600, 10)).toBeNull()

    m.release(first as string)
    const second = m.reserve('c1', 600, 10)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('counts outstanding reservations against the per-client cap', () => {
    const m = new Meter({ ...defaultMeterConfig(), perClientCapMicroUsd: 1000 })
    const first = m.reserve('c1', 600, 10)
    expect(first).not.toBeNull()
    expect(m.reserve('c1', 600, 10)).toBeNull()
    expect(m.reserve('c2', 600, 10)).not.toBeNull()
  })
})

describe('validator stub contract', () => {
  it('withholds digit prose, passes empty prose', () => {
    expect(hermeticStubValidator.validate('', []).pass).toBe(true)
    expect(hermeticStubValidator.validate('rent is 1200', []).pass).toBe(false)
  })
})

describe('proxy route', () => {
  it('rejects non-allowlisted paths and models', async () => {
    const deps = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider(),
      allowedModels: ['spark-test'],
    }
    const bad = await handleIntent(
      { method: 'POST', path: '/api/muse/explain', body: {}, clientId: 'c1' },
      deps,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('not_allowlisted')
  })

  it('returns validated intent on the happy path', async () => {
    const deps = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider({
        async intent() {
          return {
            intent: {
              mode: 'lookup',
              geographies: ['96778'],
              metricKeys: ['median_gross_rent'],
              filters: [],
              clarificationNeeded: false,
            },
          }
        },
      }),
      allowedModels: ['spark-test'],
    }
    const ok = await handleIntent(
      { method: 'POST', path: '/api/muse/intent', body: { slots: {} }, clientId: 'c1' },
      deps,
    )
    expect(ok.status).toBe(200)
  })
})
