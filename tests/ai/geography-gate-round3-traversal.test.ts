import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import type { ComposedAnswer } from '../../src/core/ai/answer'

const TAX_QUESTION =
  'which state has no income tax? or sales tax? and for those states, which zip codes have the lowest cost of living?'
const PREDICATE_VARIANT =
  "which states have no sales tax, and what's the cheapest rent zip there?"

/**
 * Geography-gate round 3 traversal (2026-11-04): the tax specimen
 * end to end. On the round-1 build the specimen never reached the
 * gate: decomposition dropped its classification clause, the
 * state-subject reading supplied every state's aggregate, and the
 * pipeline ranked them by the parse's first metric (household
 * income) while the asked measure (cost of living) stamped
 * not-measurable. These pins hold the cured order on the full
 * runner -> pipeline path: classification first (per alternative),
 * the aggregate supply suppressed under a formed gate, the screen
 * bounded to the union, the bounded screen ranked by the ASKED
 * measure even when the intent leads with another, and the
 * aggregate path itself ranking by the asked measure for the
 * questions that legitimately stay there.
 */

const TOWNS: { town: string; state: string; zip: string }[] = [
  { town: 'Anchorage', state: 'AK', zip: '99501' },
  { town: 'Fairbanks', state: 'AK', zip: '99701' },
  { town: 'El Paso', state: 'TX', zip: '79901' },
  { town: 'Austin', state: 'TX', zip: '73301' },
  { town: 'Miami', state: 'FL', zip: '33101' },
  { town: 'Salem', state: 'OR', zip: '97301' },
  { town: 'Dover', state: 'DE', zip: '19901' },
  { town: 'Corbin', state: 'KY', zip: '40771' },
  { town: 'Bangor', state: 'ME', zip: '04401' },
]

const PLACES: PlaceSuggestion[] = TOWNS.map((t) => ({
  displayName: t.town,
  censusName: `${t.town} city`,
  state: t.state,
  isCity: true,
  zips: [t.zip],
}))
const BY_ZIP = new Map<string, PlaceRecord>(
  TOWNS.map(
    (t) =>
      [
        t.zip,
        {
          zip: t.zip,
          censusName: `${t.town} city`,
          displayName: t.town,
          state: t.state,
          isCity: true,
          incorporated: true,
        },
      ] as const,
  ),
)
const INDEX = new PlaceIndex(BY_ZIP, PLACES)

/**
 * A nine-place country. Corbin, KY is the national cheapest by
 * rent AND by income but sits outside every classified set. Dover,
 * DE carries the lowest income in the set but a mid rent — so an
 * income-ranked answer and a rent-ranked answer name different
 * heads, and the pins can tell them apart. Every row carries
 * population 100, so each state aggregate is the plain mean of its
 * rows (AK rent 1250, TX rent 1125, ME age 45 the oldest).
 */
const ROWS: AreaRow[] = [
  { zcta: '99501', name: 'Anchorage, AK', metrics: { median_gross_rent: 1400, median_household_income: 80000, median_age: 35, population: 100 }, moes: { median_gross_rent: 50 } },
  { zcta: '99701', name: 'Fairbanks, AK', metrics: { median_gross_rent: 1100, median_household_income: 75000, median_age: 33, population: 100 }, moes: { median_gross_rent: 45 } },
  { zcta: '79901', name: 'El Paso, TX', metrics: { median_gross_rent: 950, median_household_income: 52000, median_age: 33, population: 100 }, moes: { median_gross_rent: 30 } },
  { zcta: '73301', name: 'Austin, TX', metrics: { median_gross_rent: 1300, median_household_income: 70000, median_age: 34, population: 100 }, moes: { median_gross_rent: 40 } },
  { zcta: '33101', name: 'Miami, FL', metrics: { median_gross_rent: 1600, median_household_income: 55000, median_age: 40, population: 100 }, moes: { median_gross_rent: 60 } },
  { zcta: '97301', name: 'Salem, OR', metrics: { median_gross_rent: 1050, median_household_income: 60000, median_age: 39, population: 100 }, moes: { median_gross_rent: 35 } },
  { zcta: '19901', name: 'Dover, DE', metrics: { median_gross_rent: 1150, median_household_income: 41000, median_age: 41, population: 100 }, moes: { median_gross_rent: 40 } },
  { zcta: '40771', name: 'Corbin, KY', metrics: { median_gross_rent: 99, median_household_income: 30000, median_age: 38, population: 100 }, moes: { median_gross_rent: 10 } },
  { zcta: '04401', name: 'Bangor, ME', metrics: { median_gross_rent: 1000, median_household_income: 48000, median_age: 45, population: 100 }, moes: { median_gross_rent: 38 } },
]

function intent(partial: Partial<ValidatedIntent> = {}): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

const TAX_SOURCES = [{ title: 'State tax roundup', url: 'https://example.org/tax-roundup' }]

const TAX_PROSE =
  'Alaska has no state income tax. Texas has no state income tax. Florida has no state income tax. ' +
  'Alaska has no statewide sales tax. Oregon does not levy a sales tax. Delaware has no sales tax.'

const SALES_PROSE =
  'Alaska has no statewide sales tax. Delaware has no sales tax. Montana has no general sales tax. ' +
  'New Hampshire has no sales tax on goods. Oregon does not levy a sales tax.'

function scriptedProvider(classificationProse: string, calls: string[]) {
  return createStubProvider({
    async research(req: ResearchRequest) {
      calls.push(req.queryText)
      if (req.queryText.includes('For the state part of the question')) {
        return { prose: classificationProse, sources: TAX_SOURCES }
      }
      const places = req.places ?? []
      return {
        prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
        sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
      }
    },
  })
}

describe('geography gate round 3 traversal: the tax specimen', () => {
  it('classifies per alternative first, suppresses the state aggregates, screens the union ranked by the asked measure', async () => {
    const calls: string[] = []
    const preliminaries: ComposedAnswer[] = []
    // The live parse's shape: the intent leads with household
    // income, the measure that silently ranked the specimen.
    const liveIntent = intent({ metricKeys: ['median_household_income'] })
    const answer = await composeAnswerForRequest({
      intent: liveIntent,
      queryText: TAX_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(liveIntent, INDEX),
      provider: scriptedProvider(TAX_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
      onPreliminary: (a) => preliminaries.push(a),
    })
    expect(answer).not.toBeNull()
    expect(answer!.status).toBe('verified')

    // Classification first, and the ask enumerates each part.
    expect(calls[0]).toContain('For the state part of the question')
    expect(calls[0]).toContain('each part of the criterion separately')

    // The gate formed over the union; no state average anywhere —
    // the aggregate supply the state-subject reading added was
    // suppressed under the formed gate (A3).
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['AK', 'DE', 'FL', 'OR', 'TX'])
    const names = answer!.places.map((p) => p.name)
    expect(names.some((n) => n.includes('state average'))).toBe(false)

    // Assessed count = the union subset (AK 2 + TX 2 + FL 1 + OR 1
    // + DE 1 = 7); the national cheapest never appears.
    expect(answer!.screenedCount).toBe(7)
    expect(names).not.toContain('Corbin, KY')
    expect(names).not.toContain('Bangor, ME')
    for (const name of names) expect(name).toMatch(/, (AK|TX|FL|OR|DE)$/)

    // Ranked by the ASKED measure (rent), not the intent's first
    // metric (income): El Paso ($950 rent) heads, not Dover
    // (lowest income, $1,150 rent) (A4/A5 in the gate path).
    expect(names[0]).toBe('El Paso, TX')
    expect(answer!.summary).toContain('El Paso, TX')

    // Criteria honesty: the tax criterion is accounted part by
    // part with the overlap named; the cost criterion is measured
    // on the bounded screen, not stamped not-measurable (A2/A5).
    const taxEntry = answer!.criterionEvidence.find(
      (e) => e.criterion === 'No income tax? or sales tax',
    )
    expect(taxEntry?.status).toBe('met')
    expect(taxEntry?.detail).toContain('part by part')
    expect(taxEntry?.detail).toContain('No income tax:')
    expect(taxEntry?.detail).toContain('No sales tax:')
    expect(taxEntry?.detail).toContain('Alaska meets more than one part')
    expect(taxEntry?.detail).toContain('the union of 5 states')
    const costEntry = answer!.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(costEntry?.status).toBe('met')
    expect(answer!.geographyDisclosures.join(' ')).toContain(
      'The cost screen ran inside the 5 states',
    )

    // The gate record's standings: each bound state's cheapest.
    const standing = (code: string) => gate!.standings.find((s) => s.code === code)
    expect(standing('TX')?.cheapestPlaceName).toBe('El Paso, TX')
    expect(standing('AK')?.cheapestPlaceName).toBe('Fairbanks, AK')
    expect(standing('OR')?.cheapestRent).toBe(1050)

    // The preliminary ran under the same bound.
    expect(preliminaries).toHaveLength(1)
    expect(preliminaries[0]!.screenedCount).toBe(7)
  })

  it('the single-criterion predicate variant gates and bounds the same way', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: PREDICATE_VARIANT,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(SALES_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer!.status).toBe('verified')
    expect(calls[0]).toContain('For the state part of the question')
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    // Classified {AK, DE, MT, NH, OR}; rows exist for AK, DE, OR.
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['AK', 'DE', 'MT', 'NH', 'OR'])
    expect(answer!.screenedCount).toBe(4)
    const names = answer!.places.map((p) => p.name)
    for (const name of names) expect(name).toMatch(/, (AK|DE|OR)$/)
    expect(names[0]).toBe('Salem, OR')
  })
})

describe('geography gate round 3 traversal: no-gate controls', () => {
  it('the FM-9 state superlative is never forced through research gating', async () => {
    const calls: string[] = []
    const ageIntent = intent({ metricKeys: ['median_age'] })
    const answer = await composeAnswerForRequest({
      intent: ageIntent,
      queryText: 'Which state has the oldest population?',
      rows: ROWS,
      resolved: resolveAnswerGeographies(ageIntent, INDEX),
      provider: scriptedProvider(TAX_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    expect(answer!.geographyGate).toBeUndefined()
    expect(calls.every((q) => !q.includes('For the state part of the question'))).toBe(true)
    // The shipped state-average terminal stands, ranked by age.
    const names = answer!.places.map((p) => p.name)
    expect(names[0]).toBe('Maine state average')
  })

  it('a state-level cost question ranks its averages by the asked measure, not the intent\u2019s first metric (A4/A5)', async () => {
    const calls: string[] = []
    const incomeIntent = intent({ metricKeys: ['median_household_income'] })
    const answer = await composeAnswerForRequest({
      intent: incomeIntent,
      queryText: 'which state has the lowest cost of living?',
      rows: ROWS,
      resolved: resolveAnswerGeographies(incomeIntent, INDEX),
      provider: scriptedProvider(TAX_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    expect(answer!.geographyGate).toBeUndefined()
    expect(calls.every((q) => !q.includes('For the state part of the question'))).toBe(true)
    // Aggregate rents: KY 99, ME 1000, OR 1050, TX 1125, DE 1150,
    // AK 1250, FL 1600. By income the order would run KY, DE, ME —
    // the asked measure (rent) governs instead.
    const names = answer!.places.map((p) => p.name)
    expect(names[0]).toBe('Kentucky state average')
    expect(names[1]).toBe('Maine state average')
    expect(names[2]).toBe('Oregon state average')
    // The cost criterion assesses on the aggregates that now carry
    // its figure — the specimen's "not measurable" stamp is gone.
    const costEntry = answer!.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(costEntry?.status).toBe('met')
  })
})
