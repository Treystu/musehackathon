import { describe, expect, it } from 'vitest'
import { canRun, withRunnability } from '../../src/core/ai/intent-schema'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { createGoldenProvider, runGolden } from '../../src/core/ai/harness'
import {
  canResolveClarification,
  removeFilter,
  removeGeography,
  resolveClarification,
} from '../../src/core/ai/intent-edit'

const compareTwo: ValidatedIntent = {
  mode: 'compare',
  geographies: ['Hilo', 'Honolulu'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const sweepOne: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['HI'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'gt', value: 1000 }],
  clarificationNeeded: false,
}

describe('canRun mode minimums (single owner)', () => {
  it('compare: 2 places runnable, 1 place not, 0 places not', () => {
    expect(canRun(compareTwo)).toBe(true)
    expect(canRun({ ...compareTwo, geographies: ['Hilo'] })).toBe(false)
    expect(canRun({ ...compareTwo, geographies: [] })).toBe(false)
  })

  it('compare: withRunnability stamps clarification below minimum', () => {
    expect(withRunnability({ ...compareTwo, geographies: ['Hilo'] }).clarificationNeeded).toBe(true)
    expect(withRunnability(compareTwo).clarificationNeeded).toBe(false)
  })

  it('sweep_filter: 1 filter runnable, 0 filters not', () => {
    expect(canRun(sweepOne)).toBe(true)
    expect(canRun({ ...sweepOne, filters: [] })).toBe(false)
    expect(
      withRunnability({ ...sweepOne, filters: [] }).clarificationNeeded,
    ).toBe(true)
  })

  it('other modes unchanged: lookup/similarity need 1 place + 1 measure, filters irrelevant', () => {
    expect(
      canRun({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    expect(
      canRun({
        mode: 'similarity',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    // Sweep with 2 filters stays runnable; lookup ignores filters.
    expect(canRun({ ...sweepOne, filters: [...sweepOne.filters, ...sweepOne.filters] })).toBe(true)
  })

  it('removal flows land in clarification via the single owner', () => {
    const pared = removeGeography(compareTwo, 'Hilo')
    expect(pared.ok).toBe(true)
    if (pared.ok) {
      expect(pared.intent.geographies).toEqual(['Honolulu'])
      expect(pared.intent.clarificationNeeded).toBe(true)
    }
    const unfiltered = removeFilter(sweepOne, sweepOne.filters[0]!)
    expect(unfiltered.ok).toBe(true)
    if (unfiltered.ok) {
      expect(unfiltered.intent.filters).toHaveLength(0)
      expect(canRun(unfiltered.intent)).toBe(false)
      expect(unfiltered.intent.clarificationNeeded).toBe(true)
    }
  })

  it('sweep clarification resolves with a real filter, not without', () => {
    const sweepFilter = { metricKey: 'median_gross_rent', op: 'gt', value: 1000 } as const
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_gross_rent'],
        filters: [{ ...sweepFilter }],
      }),
    ).toBe(true)
    expect(
      canResolveClarification({
        mode: 'sweep_filter',
        geographies: ['HI'],
        metricKeys: ['median_gross_rent'],
        filters: [],
      }),
    ).toBe(false)
    // resolveClarification threads the intent's own filters: a clarifying
    // sweep that already carries a filter resolves once place+measure land.
    const unclearSweep: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_gross_rent'],
      filters: [{ ...sweepFilter }],
      clarificationNeeded: true,
    }
    const resolved = resolveClarification(unclearSweep, {
      geographies: ['HI'],
      metricKeys: [],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.intent.clarificationNeeded).toBe(false)
      expect(resolved.intent.filters).toHaveLength(1)
    }
    const unclearNoFilter: ValidatedIntent = { ...unclearSweep, filters: [] }
    expect(
      resolveClarification(unclearNoFilter, { geographies: ['HI'], metricKeys: [] }).ok,
    ).toBe(false)
  })

  it('golden corpus still exact after minimums', async () => {
    const golden = await runGolden(createGoldenProvider())
    for (const r of golden) expect(r.exact, r.id).toBe(true)
  })
})
