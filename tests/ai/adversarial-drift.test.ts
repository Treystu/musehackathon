import { describe, expect, it } from 'vitest'
import { createStubProvider } from '../../src/core/ai/provider'
import { GOLDEN_CASES, runGolden } from '../../src/core/ai/harness'

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Independently-constructed drift provider. Every wrong intent below is a
 * hand-built literal — never a spread/mutation of golden cannedIntent
 * internals. Matching is on request slots only.
 */
function createDriftProvider() {
  return createStubProvider({
    async intent(req) {
      const mode = req.slots.modeHint
      const geo = [...(req.slots.geographyHints ?? [])]
      const met = [...(req.slots.metricHints ?? [])]
      // Control: unperturbed, hand-built correct literal.
      if (mode === 'lookup' && sameStrings(geo, ['Honolulu']) && sameStrings(met, ['population'])) {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Honolulu'],
            metricKeys: ['population'],
            filters: [],
            clarificationNeeded: false,
          },
        }
      }
      // Measure-swap: Hilo rent answered with population.
      if (mode === 'lookup' && sameStrings(geo, ['Hilo']) && sameStrings(met, ['median_gross_rent'])) {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Hilo'],
            metricKeys: ['population'],
            filters: [],
            clarificationNeeded: false,
          },
        }
      }
      // Geography-drop: Hilo+Honolulu answered with Hilo only.
      if (
        mode === 'compare' &&
        sameStrings(geo, ['Hilo', 'Honolulu']) &&
        sameStrings(met, ['median_household_income'])
      ) {
        return {
          intent: {
            mode: 'compare',
            geographies: ['Hilo'],
            metricKeys: ['median_household_income'],
            filters: [],
            clarificationNeeded: false,
          },
        }
      }
      // Mode-swap: compare answered as lookup.
      if (
        mode === 'compare' &&
        sameStrings(geo, ['96778', '96720']) &&
        sameStrings(met, ['median_gross_rent'])
      ) {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['96778', '96720'],
            metricKeys: ['median_gross_rent'],
            filters: [],
            clarificationNeeded: false,
          },
        }
      }
      // Filter-op-flip: gt 30 answered as lt 30.
      if (
        mode === 'sweep_filter' &&
        sameStrings(geo, ['HI']) &&
        sameStrings(met, ['median_rent_burden_pct'])
      ) {
        return {
          intent: {
            mode: 'sweep_filter',
            geographies: ['HI'],
            metricKeys: ['median_rent_burden_pct'],
            filters: [{ metricKey: 'median_rent_burden_pct', op: 'lt', value: 30 }],
            clarificationNeeded: false,
          },
        }
      }
      // Filter-value-change: lt 750000 answered as lt 800000.
      if (
        mode === 'sweep_filter' &&
        sameStrings(geo, ['HI']) &&
        sameStrings(met, ['median_home_value'])
      ) {
        return {
          intent: {
            mode: 'sweep_filter',
            geographies: ['HI'],
            metricKeys: ['median_home_value'],
            filters: [{ metricKey: 'median_home_value', op: 'lt', value: 800000 }],
            clarificationNeeded: false,
          },
        }
      }
      // Clarification-flip: executable answered as needing clarification.
      if (
        mode === 'similarity' &&
        sameStrings(geo, ['Hilo']) &&
        sameStrings(met, ['median_gross_rent'])
      ) {
        return {
          intent: {
            mode: 'similarity',
            geographies: ['Hilo'],
            metricKeys: ['median_gross_rent'],
            filters: [],
            clarificationNeeded: true,
          },
        }
      }
      return {
        intent: {
          mode: 'lookup',
          geographies: [],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
      }
    },
  })
}

const DRIFT_IDS = [
  'golden-lookup-hilo-rent', // measure-swap
  'golden-compare-income', // geography-drop
  'golden-compare-rent-two-places', // mode-swap
  'golden-sweep-rent-burden', // filter-op-flip
  'golden-sweep-home-value', // filter-value-change
  'golden-similarity-rent', // clarification-flip
] as const

const CONTROL_ID = 'golden-lookup-population'

async function runOne(id: string) {
  const c = GOLDEN_CASES.find((g) => g.id === id)!
  expect(c).toBeDefined()
  const golden = await runGolden(createDriftProvider(), [c])
  expect(golden).toHaveLength(1)
  return golden[0]!
}

describe('adversarial drift provider (independently constructed)', () => {
  it('control scores exact with valid verdict', async () => {
    const r = await runOne(CONTROL_ID)
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(true)
    expect(r.valid).toBe(true)
  })

  it('measure-swap flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-lookup-hilo-rent')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('geography-drop flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-compare-income')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('mode-swap flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-compare-rent-two-places')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('filter-op-flip flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-sweep-rent-burden')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('filter-value-change flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-sweep-home-value')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('clarification-flip flips exact, validator verdict stays valid', async () => {
    const r = await runOne('golden-similarity-rent')
    console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    expect(r.exact).toBe(false)
    expect(r.valid).toBe(true)
  })

  it('drift table: control exact, all six drifts non-exact and valid', async () => {
    const cases = GOLDEN_CASES.filter(
      (c) => c.id === CONTROL_ID || (DRIFT_IDS as readonly string[]).includes(c.id),
    )
    expect(cases).toHaveLength(7)
    const golden = await runGolden(createDriftProvider(), cases)
    for (const r of golden) {
      console.log(`adversarial ${r.id} exact=${r.exact} valid=${r.valid}`)
    }
    const byId = new Map(golden.map((r) => [r.id, r]))
    expect(byId.get(CONTROL_ID)?.exact).toBe(true)
    expect(byId.get(CONTROL_ID)?.valid).toBe(true)
    for (const id of DRIFT_IDS) {
      expect(byId.get(id)?.exact, id).toBe(false)
      expect(byId.get(id)?.valid, id).toBe(true)
    }
  })
})
