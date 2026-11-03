import { describe, expect, it } from 'vitest'
import {
  decomposeResearchCriteria,
  hasUnclaimedCriterionPhrase,
  isStateGeography,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { needsResearch } from '../../src/ui/ai/AskPanel'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

/**
 * Colorado nature+cost cure (owner live failure, 2026-11-03: "what
 * city in Colorado has the best nature and the lowest cost of
 * living?" answered as a 527-place rent sort — the nature criterion
 * silently dropped, cost of living stamped partially measured, no
 * correlation). The pins below hold the cured shape: decomposition
 * loses no stated criterion, a state-bounded intersection runs
 * research-first within the state, candidates rank by the
 * decomposed cost measure, and every parsed criterion ends with
 * exactly one accounting line.
 */
const COLORADO_Q = 'what city in Colorado has the best nature and the lowest cost of living?'

const CO_ROWS: AreaRow[] = [
  { zcta: '81090', name: 'Walsh, CO', metrics: { median_gross_rent: 283, median_home_value: 151100 }, moes: { median_gross_rent: 273, median_home_value: 71979 } },
  { zcta: '81047', name: 'Holly, CO', metrics: { median_gross_rent: 293, median_home_value: 157700 }, moes: { median_gross_rent: 282, median_home_value: 55661 } },
  { zcta: '81334', name: 'Towaoc, CO', metrics: { median_gross_rent: 349, median_home_value: null }, moes: { median_gross_rent: 191, median_home_value: null } },
  { zcta: '81001', name: 'Pueblo, CO', metrics: { median_gross_rent: 1050, median_home_value: 210000 }, moes: { median_gross_rent: 40, median_home_value: 5000 } },
  { zcta: '81003', name: 'Pueblo, CO', metrics: { median_gross_rent: 1100, median_home_value: 195000 }, moes: { median_gross_rent: 45, median_home_value: 6000 } },
  { zcta: '81611', name: 'Aspen, CO', metrics: { median_gross_rent: 2400, median_home_value: 2400000 }, moes: { median_gross_rent: 300, median_home_value: 200000 } },
  { zcta: '80424', name: 'Breckenridge, CO', metrics: { median_gross_rent: 1900, median_home_value: 1500000 }, moes: { median_gross_rent: 250, median_home_value: 150000 } },
  { zcta: '81301', name: 'Durango, CO', metrics: { median_gross_rent: 1500, median_home_value: 650000 }, moes: { median_gross_rent: 90, median_home_value: 30000 } },
  { zcta: '99901', name: 'Norent, CO', metrics: { median_gross_rent: null, median_home_value: 90000 }, moes: { median_gross_rent: null, median_home_value: 9000 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

const NATURE_PROSE =
  'Durango, CO sits at the edge of a national forest with trail access in every direction. ' +
  'Aspen, CO is surrounded by wilderness and scenic mountain trails. ' +
  'Breckenridge, CO offers outdoor recreation beside national forest land. ' +
  'Norent, CO is ringed by scenic public land and forest.'

function natureProvider(calls?: { count: number }) {
  return createStubProvider({
    async research() {
      if (calls) calls.count++
      return { prose: NATURE_PROSE, sources: [{ title: 't', url: 'https://example.com/nature' }] }
    },
  })
}

/** The accounting invariant: every parsed criterion has exactly one evidence line. */
function expectEveryCriterionAccounted(answer: ComposedAnswer) {
  for (const criterion of answer.researchCriteria) {
    const entries = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
    expect(entries, `criterion "${criterion.label}" accounting lines`).toHaveLength(1)
  }
}

describe('decomposition completeness', () => {
  it('decomposes the owner question into nature + cost of living', () => {
    const found = decomposeResearchCriteria(COLORADO_Q)
    expect(found.map((c) => c.id)).toEqual(['nature', 'cost_of_living'])
    expect(found.find((c) => c.id === 'nature')?.decomposedMetricKey).toBeUndefined()
    expect(found.find((c) => c.id === 'cost_of_living')?.decomposedMetricKey).toBe('median_gross_rent')
  })

  it('the research trigger fires for the owner question', () => {
    expect(needsResearch(COLORADO_Q)).toBe(true)
  })

  it('carries an unlisted criterion as combined beside a matched one', () => {
    const found = decomposeResearchCriteria('best schools and the quietest streets')
    expect(found.map((c) => c.id)).toEqual(['schools', 'combined'])
  })

  it('adds no phantom combined criterion when every phrase is claimed', () => {
    const text = 'What are the top five places that have the best schools but also the least average cost of living?'
    const found = decomposeResearchCriteria(text)
    expect(found.map((c) => c.id)).toEqual(['schools', 'cost_of_living'])
    expect(hasUnclaimedCriterionPhrase(text, found)).toBe(false)
  })

  it('keeps the total-miss combined fallback unchanged', () => {
    const found = decomposeResearchCriteria('What is the cheapest place to live in the United States?')
    expect(found.map((c) => c.id)).toEqual(['combined'])
  })

  it('reads state bounds structurally', () => {
    expect(isStateGeography('CO')).toBe(true)
    expect(isStateGeography('Colorado')).toBe(true)
    expect(isStateGeography('Nashville')).toBe(false)
    expect(isStateGeography('Nashville, TN')).toBe(false)
    expect(isStateGeography('96720')).toBe(false)
  })
})

describe('pipeline: the Colorado intersection', () => {
  it('composes the correlated candidate answer, ranked by cost', async () => {
    const calls = { count: 0 }
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: natureProvider(calls),
    })
    expect(calls.count).toBe(1)
    expect(answer.status).toBe('verified')
    // Research-first within the state: the places are the
    // research-named candidates, not the whole screen.
    expect(answer.researchNamedPlaces).toEqual([
      'Durango, CO',
      'Aspen, CO',
      'Breckenridge, CO',
      'Norent, CO',
    ])
    // Ranked by the decomposed cost measure, lowest first; the
    // candidate with no published rent figure stands last.
    expect(answer.places.map((p) => p.name)).toEqual([
      'Durango, CO',
      'Breckenridge, CO',
      'Aspen, CO',
      'Norent, CO',
    ])
    const nature = answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')
    expect(nature?.status).toBe('met')
    expect(nature?.sourceUrls.length).toBeGreaterThan(0)
    const cost = answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(cost?.status).toBe('met')
    expect(cost?.detail).toContain('not ranked on that measure')
    expect(answer.summary).not.toContain('Partially measured')
    expectEveryCriterionAccounted(answer)
  })

  it('accounts the nature criterion even when no research stage runs', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows: CO_ROWS,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: natureProvider(),
    })
    const nature = answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')
    expect(nature?.status).toBe('not_measurable')
    expectEveryCriterionAccounted(answer)
  })
})

describe('pipeline: path regressions', () => {
  it('keeps a place-level geography screen-first (the Nashville shape)', async () => {
    const rows: AreaRow[] = [
      { zcta: '37210', name: 'Nashville, TN', metrics: { median_household_income: 43343 }, moes: { median_household_income: 6619 } },
      { zcta: '37115', name: 'Nashville, TN', metrics: { median_household_income: 53034 }, moes: { median_household_income: 2860 } },
    ]
    const text = "Where can I move around Nashville that's got good schools and high wages"
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Nashville'], metricKeys: ['median_household_income'] }),
      rows,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Nashville, TN schools in this area are well regarded.',
            sources: [{ title: 't', url: 'https://example.com/schools' }],
          }
        },
      }),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(2)
    expectEveryCriterionAccounted(answer)
  })

  it('keeps a bounded state screen screen-first', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 600 }],
      }),
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: natureProvider(),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.length).toBeGreaterThan(0)
    for (const place of answer.places) {
      const rent = place.figures.find((f) => f.key === 'median_gross_rent')
      expect(rent?.value).toBeLessThanOrEqual(600)
    }
    expectEveryCriterionAccounted(answer)
  })

  it('degrades a total research failure onto the state screen (the Arkansas shape)', async () => {
    const text = 'What city in Arkansas has the best schools and the lowest cost of living?'
    const rows: AreaRow[] = [
      { zcta: '71601', name: 'Pine Bluff, AR', metrics: { median_gross_rent: 750, median_home_value: 90000 }, moes: { median_gross_rent: 10, median_home_value: 1000 } },
      { zcta: '72201', name: 'Little Rock, AR', metrics: { median_gross_rent: 1050, median_home_value: 180000 }, moes: { median_gross_rent: 10, median_home_value: 1000 } },
    ]
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['AR'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: createStubProvider({
        async research() {
          throw new Error('provider_down')
        },
      }),
    })
    // The screen carries the card; the researched criterion is
    // recorded as a lookup that did not return — never a dead end
    // and never a silent drop.
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(2)
    expect(answer.researchFailures).toEqual(['School quality'])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('not_measurable')
    expect(schools?.detail).toContain('did not return')
    expectEveryCriterionAccounted(answer)
  })

  it('completes a cost-only screen question without the partial stamp', async () => {
    const text = 'What is the lowest cost of living in Colorado?'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows: CO_ROWS,
      researchCriteria: [text],
      queryText: text,
      provider: natureProvider(),
    })
    const cost = answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(cost?.status).toBe('met')
    expect(cost?.detail).toContain('not ranked on that measure')
    expect(answer.summary).not.toContain('Partially measured')
    expectEveryCriterionAccounted(answer)
  })

  it('keeps the plain rent screen a pure screen, cheapest first', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['CO'], metricKeys: ['median_gross_rent'] }),
      rows: CO_ROWS,
      provider: natureProvider(),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.criterionEvidence).toHaveLength(0)
    const rents = answer.places.map(
      (p) => p.figures.find((f) => f.key === 'median_gross_rent')?.value,
    )
    expect(rents.slice(0, 3)).toEqual([283, 293, 349])
    expect(rents[rents.length - 1]).toBeUndefined()
  })
})

describe('pipeline: accounting battery across multi-criteria shapes', () => {
  it('schools + cost, placeless (sentence 2)', async () => {
    const text = 'What are the top five places that have the best schools but also the least average cost of living?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: ['median_gross_rent'] }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Durango, CO schools are well regarded and the town sits beside a national forest.',
            sources: [{ title: 't', url: 'https://example.com/s2' }],
          }
        },
      }),
    })
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'cost_of_living'])
    expectEveryCriterionAccounted(answer)
  })

  it('schools + Starbucks-class (Hilo)', async () => {
    const text = 'Where in Hilo has the best schools and affordable housing, with a Starbucks nearby?'
    const rows: AreaRow[] = [
      { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1346 }, moes: { median_gross_rent: 52 } },
    ]
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Hilo, HI has well-regarded schools and a Starbucks on the bay front.',
            sources: [{ title: 't', url: 'https://example.com/hilo' }],
          }
        },
      }),
    })
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'coffee'])
    expectEveryCriterionAccounted(answer)
  })

  it('an unlisted criterion beside a listed one (residue carry, end to end)', async () => {
    const text = 'Which part of Colorado has the best schools and the quietest streets?'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Durango, CO schools are well regarded, and its streets are quiet at night.',
            sources: [{ title: 't', url: 'https://example.com/quiet' }],
          }
        },
      }),
    })
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'combined'])
    expectEveryCriterionAccounted(answer)
  })
})
