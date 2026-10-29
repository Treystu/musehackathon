import { describe, expect, it } from 'vitest'
import { canRun, withRunnability } from '../../src/core/ai/intent-schema'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { createGoldenProvider, runGolden } from '../../src/core/ai/harness'
import { removeFilter, removeGeography } from '../../src/core/ai/intent-edit'

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
      // Predicate-level: below-minimum is not runnable. (removeFilter
      // bypasses withRunnability stamping today, so the flag itself is
      // asserted via withRunnability above, not via this removal path.)
      expect(canRun(unfiltered.intent)).toBe(false)
    }
  })

  it('golden corpus still exact after minimums', async () => {
    const golden = await runGolden(createGoldenProvider())
    for (const r of golden) expect(r.exact, r.id).toBe(true)
  })
})
