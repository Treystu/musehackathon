import { describe, expect, it } from 'vitest'
import {
  canRun,
  degradeDisplayOnlyDemographicIntent,
  FILTER_LEGAL_KEYS,
  isFilterLegal,
  isRankLegal,
  RANK_LEGAL_KEYS,
  validateIntent,
  withRunnability,
} from '../../src/core/ai/intent-schema'
import { intentGate } from '../../src/core/ai/validator'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { isResearchFirstHandoff, researchFirstHandoff } from '../../src/ui/ai/AskPanel'
import {
  DEMOGRAPHIC_DISPLAY_ONLY_KEYS,
  RANK_LEGAL_METRIC_KEYS,
  SORTABLE_METRIC_KEYS,
} from '../../src/core/civicscope-registry'
import type { AreaRow } from '../../src/core/plugins/acs'

/**
 * FM-9 pins (owner ruling 2026-11-03, sign-off closure): median_age is
 * rank-legal; superlatives over the other demographic figures
 * (poverty / attainment / broadband / crowding) route research-first
 * and never rank on the display-only figure; display surfaces are
 * unchanged. The A9 generality program designed the cure shape
 * (degrade, don't block) with gate receipt proceed / 0.04 / 0.95; the
 * pre-cure behavior is recorded in generality-a9-diag: an intent
 * retaining median_age was rejected whole at BOTH gates ("sweep_filter
 * uses displayable but not filter-legal key: median_age").
 */

function rawIntent(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

// Same fixture family as the A9 diagnosis harness: AZ places whose
// rent order and age order differ, so a ranking basis is observable.
const AZ_ROWS: AreaRow[] = [
  { zcta: '86336', name: 'Sedona, AZ', metrics: { median_gross_rent: 1700, median_age: 58, below_poverty_count: 5000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 400 } },
  { zcta: '85251', name: 'Scottsdale, AZ', metrics: { median_gross_rent: 1800, median_age: 47, below_poverty_count: 9000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 700 } },
  { zcta: '86442', name: 'Bullhead City, AZ', metrics: { median_gross_rent: 900, median_age: 55, below_poverty_count: 12000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 900 } },
  { zcta: '85003', name: 'Phoenix, AZ', metrics: { median_gross_rent: 1400, median_age: 34, below_poverty_count: 90000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 3000 } },
  { zcta: '85701', name: 'Tucson, AZ', metrics: { median_gross_rent: 1100, median_age: 38, below_poverty_count: 60000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 2500 } },
  { zcta: '86301', name: 'Prescott, AZ', metrics: { median_gross_rent: 1400, median_age: 56, below_poverty_count: 8000 }, moes: { median_gross_rent: 60, median_age: 2, below_poverty_count: 600 } },
]

describe('FM-9 registry lists', () => {
  it('rank-legal is exactly the sortable surface plus median_age', () => {
    expect(RANK_LEGAL_METRIC_KEYS).toEqual([...SORTABLE_METRIC_KEYS, 'median_age'])
    expect(RANK_LEGAL_KEYS).toEqual(RANK_LEGAL_METRIC_KEYS)
    for (const k of FILTER_LEGAL_KEYS) expect(isRankLegal(k)).toBe(true)
    expect(isRankLegal('median_age')).toBe(true)
    expect(isFilterLegal('median_age')).toBe(false)
  })

  it('the display-only demographic set is the four ruled figures', () => {
    expect(DEMOGRAPHIC_DISPLAY_ONLY_KEYS).toEqual([
      'below_poverty_count',
      'bachelors_count',
      'no_internet_access',
      'average_household_size',
    ])
    for (const k of DEMOGRAPHIC_DISPLAY_ONLY_KEYS) {
      expect(isRankLegal(k)).toBe(false)
      expect(isFilterLegal(k)).toBe(false)
    }
  })
})

describe('FM-9 schema gate (validateIntent / canRun)', () => {
  it('a bounded median-age sweep validates and runs', () => {
    const check = validateIntent(
      rawIntent({ geographies: ['AZ'], metricKeys: ['median_age'] }),
    )
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(canRun(check.intent)).toBe(true)
      expect(withRunnability(check.intent).clarificationNeeded).toBe(false)
    }
  })

  it('a placeless median-age sweep runs (the national-screen shape)', () => {
    const check = validateIntent(rawIntent({ metricKeys: ['median_age'] }))
    expect(check.ok).toBe(true)
    if (check.ok) expect(canRun(check.intent)).toBe(true)
  })

  it('a similarity intent may name median_age', () => {
    const check = validateIntent(
      rawIntent({ mode: 'similarity', geographies: ['Sedona, AZ'], metricKeys: ['median_age'] }),
    )
    expect(check.ok).toBe(true)
  })

  it('median_age as a FILTER still blocks — rank is not filter', () => {
    const check = validateIntent(
      rawIntent({
        geographies: ['AZ'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_age', op: 'gt', value: 50 }],
      }),
    )
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toBe('proxy_metric_blocked')
  })

  it('each display-only demographic figure still blocks as a sweep measure', () => {
    for (const k of DEMOGRAPHIC_DISPLAY_ONLY_KEYS) {
      const check = validateIntent(rawIntent({ geographies: ['AZ'], metricKeys: [k] }))
      expect(check.ok, k).toBe(false)
      if (!check.ok) expect(check.error).toBe('proxy_metric_blocked')
    }
  })
})

describe('FM-9 pipeline gate (intentGate)', () => {
  it('a sweep measure of median_age passes; a poverty measure fails as not rank-legal', () => {
    expect(
      intentGate({ mode: 'sweep_filter', metricKeys: ['median_age'], filters: [] }).pass,
    ).toBe(true)
    const bad = intentGate({ mode: 'sweep_filter', metricKeys: ['below_poverty_count'], filters: [] })
    expect(bad.pass).toBe(false)
    if (!bad.pass) expect(bad.detail).toContain('not rank-legal')
  })

  it('a sort directive may name median_age; a filter or composite may not', () => {
    expect(intentGate({ mode: 'lookup', sortBy: 'median_age' }).pass).toBe(true)
    expect(
      intentGate({
        mode: 'sweep_filter',
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_age', op: 'gt', value: 50 }],
      }).pass,
    ).toBe(false)
    expect(intentGate({ mode: 'composite', composite: ['median_age'] }).pass).toBe(false)
  })
})

describe('FM-9 pipeline behavior', () => {
  it('a median-age superlative screens and ranks on Census figures', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['AZ'], metricKeys: ['median_age'] }),
      rows: AZ_ROWS,
      queryText: 'Which town in Arizona has the highest median age?',
      provider: createStubProvider({}),
    })
    expect(answer.status).toBe('verified')
    expect(answer.failures).toEqual([])
    // The screen's ranking contract is the one every measure gets:
    // ascending by the retained measure, unknown figures last. The
    // age order (34, 38, 47, 55, 56, 58) differs from both the load
    // order and the rent order, so the basis is observable.
    expect(answer.places.map((p) => p.name)).toEqual([
      'Phoenix, AZ',
      'Tucson, AZ',
      'Scottsdale, AZ',
      'Bullhead City, AZ',
      'Prescott, AZ',
      'Sedona, AZ',
    ])
    for (const place of answer.places) {
      const figure = place.figures.find((f) => f.key === 'median_age')
      const row = AZ_ROWS.find((r) => r.zcta === place.zcta)!
      expect(figure?.value).toBe(row.metrics.median_age)
      expect(figure?.marginOfError).toBe(row.moes.median_age)
    }
  })

  it('a poverty sweep intent still blocks at the pipeline gate — it never ranks', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['AZ'], metricKeys: ['below_poverty_count'] }),
      rows: AZ_ROWS,
      queryText: 'Which town in Arizona has the most people in poverty?',
      provider: createStubProvider({}),
    })
    expect(answer.status).toBe('blocked')
    expect(answer.failures.join(' ')).toContain('not rank-legal')
    expect(answer.places).toEqual([])
  })
})

describe('FM-9 degrade (display-only demographic measures)', () => {
  it('a poverty-only parse degrades to a clarifying, measure-less intent that validates', () => {
    const degraded = degradeDisplayOnlyDemographicIntent(
      rawIntent({ geographies: ['AZ'], metricKeys: ['below_poverty_count'] }),
    )
    expect(degraded).not.toBeNull()
    expect(degraded!.metricKeys).toEqual([])
    expect(degraded!.clarificationNeeded).toBe(true)
    const check = validateIntent(degraded)
    expect(check.ok).toBe(true)
    if (check.ok) expect(withRunnability(check.intent).clarificationNeeded).toBe(true)
  })

  it('a mixed parse keeps its screenable measure and drops only the demographic key', () => {
    const degraded = degradeDisplayOnlyDemographicIntent(
      rawIntent({ geographies: ['AZ'], metricKeys: ['median_gross_rent', 'below_poverty_count'] }),
    )
    expect(degraded!.metricKeys).toEqual(['median_gross_rent'])
    expect(degraded!.clarificationNeeded).toBe(false)
    const check = validateIntent(degraded)
    expect(check.ok).toBe(true)
    if (check.ok) expect(canRun(check.intent)).toBe(true)
  })

  it('median_age survives a degrade beside a demographic key', () => {
    const degraded = degradeDisplayOnlyDemographicIntent(
      rawIntent({ geographies: ['AZ'], metricKeys: ['median_age', 'bachelors_count'] }),
    )
    expect(degraded!.metricKeys).toEqual(['median_age'])
    expect(validateIntent(degraded).ok).toBe(true)
  })

  it('every ruled demographic key degrades', () => {
    for (const k of DEMOGRAPHIC_DISPLAY_ONLY_KEYS) {
      const degraded = degradeDisplayOnlyDemographicIntent(
        rawIntent({ geographies: ['AZ'], metricKeys: [k] }),
      )
      expect(degraded, k).not.toBeNull()
      expect(degraded!.metricKeys).toEqual([])
    }
  })

  it('no degrade when the refusal has another cause', () => {
    // A non-filter-legal filter keeps the refusal.
    expect(
      degradeDisplayOnlyDemographicIntent(
        rawIntent({
          geographies: ['AZ'],
          metricKeys: ['below_poverty_count'],
          filters: [{ metricKey: 'population', op: 'gt', value: 1000 }],
        }),
      ),
    ).toBeNull()
    // Another non-rank-legal measure beside the demographic key.
    expect(
      degradeDisplayOnlyDemographicIntent(
        rawIntent({ geographies: ['AZ'], metricKeys: ['below_poverty_count', 'renter_occupied'] }),
      ),
    ).toBeNull()
    // No demographic key at all.
    expect(
      degradeDisplayOnlyDemographicIntent(
        rawIntent({ geographies: ['AZ'], metricKeys: ['median_gross_rent'] }),
      ),
    ).toBeNull()
    // Lookup measures are display context, never blocked, never degraded.
    expect(
      degradeDisplayOnlyDemographicIntent(
        rawIntent({ mode: 'lookup', geographies: ['Hilo, HI'], metricKeys: ['below_poverty_count'] }),
      ),
    ).toBeNull()
  })
})

describe('FM-9 research-first routing for demographic superlatives', () => {
  it('the degraded poverty intent hands off research-first (state and county shapes)', () => {
    for (const [geographies, query] of [
      [['AZ'], 'Which town in Arizona has the most people in poverty?'],
      [['Maricopa County, AZ'], 'Which town in Maricopa County has the most people in poverty?'],
    ] as const) {
      const degraded = degradeDisplayOnlyDemographicIntent(
        rawIntent({ geographies: [...geographies], metricKeys: ['below_poverty_count'] }),
      )
      const check = validateIntent(degraded)
      expect(check.ok).toBe(true)
      if (!check.ok) continue
      const parsed = withRunnability(check.intent)
      const handedOff = researchFirstHandoff(parsed, query)
      expect(handedOff, query).not.toBeNull()
      expect(isResearchFirstHandoff(handedOff!)).toBe(true)
    }
  })

  it('the research-first card is ordered by the research, never by the poverty figure', async () => {
    const degraded = degradeDisplayOnlyDemographicIntent(
      rawIntent({ geographies: ['AZ'], metricKeys: ['below_poverty_count'] }),
    )
    const check = validateIntent(degraded)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const handedOff = researchFirstHandoff(
      withRunnability(check.intent),
      'Which town in Arizona has the most people in poverty?',
    )
    expect(handedOff).not.toBeNull()
    const provider = createStubProvider({
      async research() {
        return {
          prose:
            'Phoenix, AZ has the most people in poverty of any Arizona town in recent counts. ' +
            'Tucson, AZ also has a large number of people in poverty. ' +
            'Answer: Phoenix, AZ has the strongest support for the most people in poverty.',
          sources: [{ title: 'Poverty findings', url: 'https://example.com/poverty' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: { ...handedOff!, clarificationNeeded: false },
      rows: AZ_ROWS,
      researchQuery: 'Which town in Arizona has the most people in poverty?',
      queryText: 'Which town in Arizona has the most people in poverty?',
      provider,
    })
    expect(answer.status).toBe('verified')
    // Claim order (Phoenix, Tucson). Poverty-ascending would put
    // Sedona first and Phoenix last; the figure never ranks.
    expect(answer.places.map((p) => p.name)).toEqual(['Phoenix, AZ', 'Tucson, AZ'])
  })
})
