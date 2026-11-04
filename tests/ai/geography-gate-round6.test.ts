import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'
import {
  classificationGaps,
  classifyStatesFromResearch,
  detectGeographyGate,
  gateClassificationReaskQueryText,
  type GeographyGateSpec,
} from '../../src/core/ai/geography-gate'
import { RESEARCH_QUERY_MAX_CHARS } from '../../src/core/ai/meta-client'

/**
 * Geography-gate round 6 (2026-11-04): classification completeness
 * per alternative. Live on 67da19c the gate engaged and the map
 * matched the bound — but the bound was wrong upstream: the
 * classification research named NO state for the no-income-tax
 * alternative while the no-sales-tax alternative classified its
 * 5, so the union bound was 5 states instead of 12, and the
 * pipeline accepted the empty part as the classification.
 *
 * The classifier-side loss shapes were reproduced in-tree against
 * the shipped classifier before this cure (DRUG-LAW-GATE-R6.md):
 * a spelled-out count with the list in the next sentence reads
 * EMPTY (the enumeration announcement recognizes digit counts
 * only, and the list sentence asserts nothing); "does not tax
 * income" / "has no tax on income" word orders read EMPTY (the
 * absence patterns require the exact phrase after the negator);
 * a heading plus a bare list reads EMPTY; and a counted claim
 * naming only examples enumerates the examples alone (a claimed
 * nine, a classified three) with nothing noticing. The cure is a
 * completeness check, not more pattern surface: a part that comes
 * back empty, or smaller than its own prose's count claim, earns
 * ONE enumeration-demanding re-ask for that part alone, in the
 * per-state assertion shape the classifier reads; a part still
 * empty after the re-ask stands as honestly naming no state.
 */

const TAX_QUESTION =
  'which state has no income tax? or sales tax? and for those states, which zip codes have the lowest cost of living?'
const DRUG_QUESTION =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'

const TOWNS: { town: string; state: string; zip: string; rent: number }[] = [
  { town: 'Anchorage', state: 'AK', zip: '99501', rent: 1400 },
  { town: 'Miami', state: 'FL', zip: '33101', rent: 1600 },
  { town: 'Reno', state: 'NV', zip: '89501', rent: 1300 },
  { town: 'Concord', state: 'NH', zip: '03301', rent: 1200 },
  { town: 'Little Eagle', state: 'SD', zip: '57639', rent: 244 },
  { town: 'Nashville', state: 'TN', zip: '37201', rent: 1100 },
  { town: 'El Paso', state: 'TX', zip: '79901', rent: 950 },
  { town: 'Seattle', state: 'WA', zip: '98101', rent: 1700 },
  { town: 'Cheyenne', state: 'WY', zip: '82001', rent: 1000 },
  { town: 'Dover', state: 'DE', zip: '19901', rent: 1150 },
  { town: 'Helena', state: 'MT', zip: '59601', rent: 1050 },
  { town: 'Salem', state: 'OR', zip: '97301', rent: 1050 },
  { town: 'Bridgeport', state: 'CA', zip: '93517', rent: 225 },
  { town: 'Elizabethtown', state: 'IL', zip: '62931', rent: 235 },
  { town: 'White Earth', state: 'MN', zip: '56591', rent: 198 },
  { town: 'Boulder', state: 'CO', zip: '80301', rent: 1800 },
  { town: 'Corbin', state: 'KY', zip: '40771', rent: 99 },
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
const ROWS: AreaRow[] = TOWNS.map((t) => ({
  zcta: t.zip,
  name: `${t.town}, ${t.state}`,
  metrics: { median_gross_rent: t.rent },
  moes: { median_gross_rent: 30 },
}))

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

const SOURCES = [{ title: 'State tax roundup', url: 'https://example.org/taxes' }]
const INCOME_STATES = [
  'Alaska', 'Florida', 'Nevada', 'New Hampshire', 'South Dakota',
  'Tennessee', 'Texas', 'Washington', 'Wyoming',
]
const SALES_SENTENCES =
  'Alaska has no statewide sales tax. Delaware has no sales tax. Montana has no general sales tax. ' +
  'New Hampshire has no sales tax on goods. Oregon does not levy a sales tax.'
/** The re-ask's demanded shape: one absence sentence per state. */
const INCOME_PER_STATE = INCOME_STATES.map((s) => `${s} has no income tax.`).join(' ')
/** Shape A (proven loss): spelled count, list in the NEXT sentence — income reads empty. */
const LIVE_SHAPE_PROSE =
  `Nine states have no income tax. They are ${INCOME_STATES.join(', ')}. ${SALES_SENTENCES}`
/** Shape C (proven loss): counted claim naming only examples — income reads 3 of a claimed 9. */
const COUNTED_EXAMPLES_PROSE =
  `Nine states have no income tax, including Alaska, Florida, and Texas. ${SALES_SENTENCES}`
/** A complete first pass: the round-3 colon-list fixture shape. */
const COMPLETE_PROSE =
  `Nine states have no income tax: ${INCOME_STATES.join(', ')}. ${SALES_SENTENCES}`

const UNION_12 = ['AK', 'DE', 'FL', 'MT', 'NV', 'NH', 'OR', 'SD', 'TN', 'TX', 'WA', 'WY']

/**
 * The route-shaped stub (round 4's discipline): refuses any
 * queryText over the route ceiling. The FIRST classification ask
 * gets `firstProse`; the re-ask (marked ", again,") gets
 * `reaskProse`; every classification call's text is recorded in
 * `classificationCalls` so call counts pin exactly.
 */
function routeShapedProvider(
  firstProse: string,
  reaskProse: string,
  classificationCalls: string[],
) {
  return createStubProvider({
    async research(req: ResearchRequest) {
      if (req.queryText.length > RESEARCH_QUERY_MAX_CHARS) {
        throw new Error('shape_invalid: research needs a queryText within the ceiling')
      }
      if (req.queryText.includes('For the state part of the question, again')) {
        classificationCalls.push(req.queryText)
        return { prose: reaskProse, sources: SOURCES }
      }
      if (req.queryText.includes('For the state part of the question')) {
        classificationCalls.push(req.queryText)
        return { prose: firstProse, sources: SOURCES }
      }
      const places = req.places ?? []
      return {
        prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
        sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
      }
    },
  })
}

async function runTax(firstProse: string, reaskProse: string, classificationCalls: string[]) {
  return composeAnswerForRequest({
    intent: intent(),
    queryText: TAX_QUESTION,
    rows: ROWS,
    resolved: resolveAnswerGeographies(intent(), INDEX),
    provider: routeShapedProvider(firstProse, reaskProse, classificationCalls),
    research: true,
    placeIndex: INDEX,
    stack: false,
  })
}

const taxSpec = (): GeographyGateSpec =>
  detectGeographyGate({
    queryText: TAX_QUESTION,
    intent: intent(),
    researchCriteria: decomposeResearchCriteria(TAX_QUESTION),
  })!

describe('round 6: the completeness check reads gaps from the prose itself', () => {
  it('shape A: the empty income part is a gap carrying its spelled-out count claim', () => {
    const classification = classifyStatesFromResearch(LIVE_SHAPE_PROSE, taxSpec())
    const byLabel = new Map(
      classification.alternatives!.map((a) => [a.label, a.states.map((s) => s.code)]),
    )
    // The RCA, pinned: this shape classifies the income part EMPTY.
    expect(byLabel.get('no income tax')).toEqual([])
    expect(byLabel.get('no sales tax')).toEqual(['AK', 'DE', 'MT', 'NH', 'OR'])
    const gaps = classificationGaps(LIVE_SHAPE_PROSE, classification, taxSpec())
    expect(gaps).toEqual([
      { label: 'no income tax', phrase: 'income tax', negated: true, claimedCount: 9, classifiedCount: 0 },
    ])
  })

  it('shape C: a counted claim larger than the enumerated set is a gap', () => {
    const classification = classifyStatesFromResearch(COUNTED_EXAMPLES_PROSE, taxSpec())
    const gaps = classificationGaps(COUNTED_EXAMPLES_PROSE, classification, taxSpec())
    expect(gaps).toEqual([
      { label: 'no income tax', phrase: 'income tax', negated: true, claimedCount: 9, classifiedCount: 3 },
    ])
  })

  it('a complete first pass has no gaps', () => {
    const classification = classifyStatesFromResearch(COMPLETE_PROSE, taxSpec())
    expect(classificationGaps(COMPLETE_PROSE, classification, taxSpec())).toEqual([])
  })

  it('single-criterion: a counted class claim larger than the class is a gap', () => {
    const drugSpec = detectGeographyGate({
      queryText: DRUG_QUESTION,
      intent: intent(),
      researchCriteria: decomposeResearchCriteria(DRUG_QUESTION),
    })!
    const prose =
      'Recreational marijuana is fully legal in 24 states, including California, Illinois, and Minnesota. ' +
      'Marijuana remains illegal in Kentucky.'
    const classification = classifyStatesFromResearch(prose, drugSpec)
    expect(classification.favorableStates.map((s) => s.code)).toEqual(['CA', 'IL', 'MN'])
    expect(classificationGaps(prose, classification, drugSpec)).toEqual([
      { label: null, phrase: null, negated: false, claimedCount: 24, classifiedCount: 3 },
    ])
  })
})

describe('round 6: the re-ask fits the route ceiling', () => {
  it('both-parts, one-part, and single-criterion re-asks are within the ceiling, question first', () => {
    const spec = taxSpec()
    const both = gateClassificationReaskQueryText(TAX_QUESTION, spec, [
      { label: 'no income tax', phrase: 'income tax', negated: true, claimedCount: 9, classifiedCount: 0 },
      { label: 'no sales tax', phrase: 'sales tax', negated: true, claimedCount: 5, classifiedCount: 0 },
    ])
    expect(both.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    expect(both.startsWith(TAX_QUESTION)).toBe(true)
    expect(both).toContain('For the part "no income tax"')
    expect(both).toContain('For the part "no sales tax"')
    const drugSpec = detectGeographyGate({
      queryText: DRUG_QUESTION,
      intent: intent(),
      researchCriteria: decomposeResearchCriteria(DRUG_QUESTION),
    })!
    const single = gateClassificationReaskQueryText(DRUG_QUESTION, drugSpec, [
      { label: null, phrase: null, negated: false, claimedCount: 24, classifiedCount: 3 },
    ])
    expect(single.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    expect(single.startsWith(DRUG_QUESTION)).toBe(true)
  })
})

describe('round 6: traversal — the re-ask completes the incomplete part', () => {
  it('(b) empty part beside a complete sibling: re-ask completes it, the union binds 12', async () => {
    const calls: string[] = []
    const answer = await runTax(LIVE_SHAPE_PROSE, INCOME_PER_STATE, calls)
    expect(answer).not.toBeNull()
    // Exactly two classification calls: the first ask + ONE re-ask.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('For the part "no income tax"')
    expect(calls[1]).not.toContain('For the part "no sales tax"')
    expect(calls[1]!.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(UNION_12)
    expect(answer!.screenedCount).toBe(12)
    expect(answer!.places.map((p) => p.name)).not.toContain('Corbin, KY')
    expect(answer!.places[0]!.name).toBe('Little Eagle, SD')
    // The per-part accounting renders in the criterion evidence.
    const gateEntry = answer!.criterionEvidence.find((e) => e.criterion === gate!.criterionLabel)
    expect(gateEntry).toBeDefined()
    expect(gateEntry!.detail).toContain('No income tax:')
    expect(gateEntry!.detail).toContain('(9 states)')
    expect(gateEntry!.detail).toContain('No sales tax:')
    expect(gateEntry!.detail).toContain('(5 states)')
    expect(gateEntry!.detail).toContain('the union of 12 states')
  })

  it('(a) counted-but-under-enumerated part: re-ask fires and the full set classifies', async () => {
    const calls: string[] = []
    const answer = await runTax(COUNTED_EXAMPLES_PROSE, INCOME_PER_STATE, calls)
    expect(calls).toHaveLength(2)
    expect(answer!.geographyGate!.boundStates.map((s) => s.code)).toEqual(UNION_12)
    expect(answer!.screenedCount).toBe(12)
  })

  it('(d) a complete first pass issues NO re-ask', async () => {
    const calls: string[] = []
    const answer = await runTax(COMPLETE_PROSE, INCOME_PER_STATE, calls)
    expect(calls).toHaveLength(1)
    expect(answer!.geographyGate!.boundStates.map((s) => s.code)).toEqual(UNION_12)
    expect(answer!.screenedCount).toBe(12)
  })

  it('(c) genuinely empty prose: exactly one re-ask, the honest empty stands, the fallback is intact', async () => {
    const calls: string[] = []
    const answer = await runTax(
      'No state-by-state characterization was found in the sources reviewed.',
      'No state-by-state characterization was found in the sources reviewed.',
      calls,
    )
    expect(calls).toHaveLength(2)
    expect(answer!.geographyGate).toBeUndefined()
    expect(answer!.geographyGateFailure?.reason).toBe(
      'the cited research named no state meeting this criterion',
    )
  })

  it('(c2) one part empty even after its re-ask: the gate binds the sibling part and names the empty part', async () => {
    const calls: string[] = []
    const answer = await runTax(LIVE_SHAPE_PROSE, 'No further enumeration was found.', calls)
    expect(calls).toHaveLength(2)
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['AK', 'DE', 'MT', 'NH', 'OR'])
    const gateEntry = answer!.criterionEvidence.find((e) => e.criterion === gate!.criterionLabel)
    expect(gateEntry!.detail).toContain('No income tax: no state named by the research')
    expect(gateEntry!.detail).toContain('No sales tax:')
    expect(gateEntry!.detail).toContain('(5 states)')
  })

  it('single-criterion: an under-counted superlative class earns the same one re-ask', async () => {
    const calls: string[] = []
    const firstProse =
      'Recreational marijuana is fully legal in 24 states, including California, Illinois, and Minnesota. ' +
      'Marijuana remains illegal in Kentucky.'
    const reaskProse =
      'Recreational marijuana is fully legal in California. Recreational marijuana is fully legal in Illinois. ' +
      'Recreational marijuana is fully legal in Minnesota. Recreational marijuana is fully legal in Colorado. ' +
      'Recreational marijuana is fully legal in Oregon.'
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: DRUG_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: routeShapedProvider(firstProse, reaskProse, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(calls).toHaveLength(2)
    expect(answer!.geographyGate!.boundStates.map((s) => s.code)).toEqual([
      'CA', 'CO', 'IL', 'MN', 'OR',
    ])
    expect(answer!.places.map((p) => p.name)).not.toContain('Corbin, KY')
  })
})
