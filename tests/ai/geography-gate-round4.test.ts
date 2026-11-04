import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { decomposeResearchCriteria, verifyAnswer } from '../../src/core/ai/answer'
import {
  detectGeographyGate,
  gateClassificationQueryText,
  rerouteGateShape,
} from '../../src/core/ai/geography-gate'
import { RESEARCH_QUERY_MAX_CHARS } from '../../src/core/ai/meta-client'

/**
 * Geography-gate round 4 (2026-11-04): the gate did not fire live
 * on production 5c32847 for EITHER specimen while every traversal
 * pin passed. Root cause, measured in-tree: the classification
 * ask exceeded the research route's query ceiling
 * (RESEARCH_QUERY_MAX_CHARS = 500) — 760 chars for the tax
 * specimen, 611 for the drug specimen — the route refused it as
 * shape_invalid, and the runner converted the refusal to a silent
 * null, so the gate never formed. The round-1 ask that gated live
 * on 2e04268 measured exactly 500. Every stub provider in the
 * earlier pins accepts any query length, so the divergence was
 * invisible in-tree.
 *
 * These pins are built from the LIVE-SHAPED realizations the
 * probe observed, not only the round-3 fixture parse:
 *  - a ROUTE-SHAPED provider stub that refuses any research
 *    queryText over the ceiling exactly as the route does;
 *  - the similarity-mode intent realization (the drug specimen's
 *    live parse has taken it before);
 *  - the split-residue decomposition (per-criterion
 *    outside-Census lines: each tax alternative its own combined
 *    criterion);
 *  - a classification failure, with the probe's deflection /
 *    disjoint / gate-map prose riding the pipeline research, so
 *    the detected-but-unapplied accounting and the claim
 *    discipline are pinned end to end.
 */

const DRUG_QUESTION =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'
const TAX_QUESTION =
  'which state has no income tax? or sales tax? and for those states, which zip codes have the lowest cost of living?'

const TOWNS: { town: string; state: string; zip: string }[] = [
  { town: 'Anchorage', state: 'AK', zip: '99501' },
  { town: 'El Paso', state: 'TX', zip: '79901' },
  { town: 'Miami', state: 'FL', zip: '33101' },
  { town: 'Salem', state: 'OR', zip: '97301' },
  { town: 'Dover', state: 'DE', zip: '19901' },
  { town: 'Corbin', state: 'KY', zip: '40771' },
  { town: 'Bridgeport', state: 'CA', zip: '93517' },
  { town: 'Elizabethtown', state: 'IL', zip: '62931' },
  { town: 'White Earth', state: 'MN', zip: '56591' },
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

const ROWS: AreaRow[] = [
  { zcta: '99501', name: 'Anchorage, AK', metrics: { median_gross_rent: 1400, median_household_income: 80000 }, moes: { median_gross_rent: 50 } },
  { zcta: '79901', name: 'El Paso, TX', metrics: { median_gross_rent: 950, median_household_income: 52000 }, moes: { median_gross_rent: 30 } },
  { zcta: '33101', name: 'Miami, FL', metrics: { median_gross_rent: 1600, median_household_income: 55000 }, moes: { median_gross_rent: 60 } },
  { zcta: '97301', name: 'Salem, OR', metrics: { median_gross_rent: 1050, median_household_income: 60000 }, moes: { median_gross_rent: 35 } },
  { zcta: '19901', name: 'Dover, DE', metrics: { median_gross_rent: 1150, median_household_income: 41000 }, moes: { median_gross_rent: 40 } },
  { zcta: '40771', name: 'Corbin, KY', metrics: { median_gross_rent: 99, median_household_income: 30000 }, moes: { median_gross_rent: 10 } },
  { zcta: '93517', name: 'Bridgeport, CA', metrics: { median_gross_rent: 225, median_household_income: 48000 }, moes: { median_gross_rent: 92 } },
  { zcta: '62931', name: 'Elizabethtown, IL', metrics: { median_gross_rent: 235, median_household_income: 52000 }, moes: { median_gross_rent: 63 } },
  { zcta: '56591', name: 'White Earth, MN', metrics: { median_gross_rent: 198, median_household_income: 39000 }, moes: { median_gross_rent: 160 } },
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

const SOURCES = [{ title: 'State policy roundup', url: 'https://example.org/roundup' }]
const TAX_PROSE =
  'Alaska has no state income tax. Texas has no state income tax. Florida has no state income tax. ' +
  'Alaska has no statewide sales tax. Oregon does not levy a sales tax. Delaware has no sales tax.'
const DRUG_PROSE =
  'Recreational marijuana is fully legal in California, Illinois, and Minnesota. ' +
  'Marijuana remains illegal in Kentucky.'

/**
 * The route-shaped stub: like functions/api/muse/research.ts, it
 * refuses any queryText over RESEARCH_QUERY_MAX_CHARS (the route
 * answers 400 shape_invalid; the provider surfaces that as a
 * failed call). Every other call is served from the script.
 */
function routeShapedProvider(classificationProse: string, calls: string[]) {
  return createStubProvider({
    async research(req: ResearchRequest) {
      calls.push(req.queryText)
      if (req.queryText.length > RESEARCH_QUERY_MAX_CHARS) {
        throw new Error('shape_invalid: research needs a queryText within the ceiling')
      }
      if (req.queryText.includes('For the state part of the question')) {
        return { prose: classificationProse, sources: SOURCES }
      }
      const places = req.places ?? []
      return {
        prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
        sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
      }
    },
  })
}

describe('round 4: the classification ask fits the research route ceiling', () => {
  it('both specimens asks are within the ceiling, question verbatim first', () => {
    for (const q of [DRUG_QUESTION, TAX_QUESTION]) {
      const spec = detectGeographyGate({
        queryText: q,
        intent: intent(),
        researchCriteria: decomposeResearchCriteria(q),
      })
      expect(spec).not.toBeNull()
      const ask = gateClassificationQueryText(q, spec!)
      expect(ask.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
      expect(ask.startsWith(q)).toBe(true)
      expect(ask).toContain('For the state part of the question')
    }
  })
})

describe('round 4: both specimens gate under the route-shaped provider', () => {
  it('tax specimen: union bound, asked measure, per-alternative evidence', async () => {
    const calls: string[] = []
    const liveIntent = intent({ metricKeys: ['median_household_income'] })
    const answer = await composeAnswerForRequest({
      intent: liveIntent,
      queryText: TAX_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(liveIntent, INDEX),
      provider: routeShapedProvider(TAX_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    // The classification call was the FIRST research call and it
    // fit the ceiling the route enforces.
    expect(calls[0]).toContain('For the state part of the question')
    expect(calls[0]!.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['AK', 'DE', 'FL', 'OR', 'TX'])
    expect(answer!.screenedCount).toBe(5)
    expect(answer!.places.map((p) => p.name)).not.toContain('Corbin, KY')
    expect(answer!.places[0]!.name).toBe('El Paso, TX')
    expect(answer!.geographyGateFailure).toBeUndefined()
  })

  it('drug specimen: broad class bound, Corbin excluded, Bridgeport at its row figure', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: DRUG_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: routeShapedProvider(DRUG_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    expect(calls[0]!.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['CA', 'IL', 'MN'])
    const names = answer!.places.map((p) => p.name)
    expect(names).not.toContain('Corbin, KY')
    const bridgeport = answer!.places.find((p) => p.name === 'Bridgeport, CA')
    expect(bridgeport!.figures.find((f) => f.key === 'median_gross_rent')!.value).toBe(225)
    expect(verifyAnswer(answer!, ROWS).ok).toBe(true)
  })
})

describe('round 4: the similarity-mode realization', () => {
  it('detection forms on a similarity-labelled placeless parse; the panel re-route rewrites it', () => {
    const simIntent = intent({ mode: 'similarity', metricKeys: [] })
    const criteria = decomposeResearchCriteria(DRUG_QUESTION)
    const spec = detectGeographyGate({
      queryText: DRUG_QUESTION,
      intent: simIntent,
      researchCriteria: criteria,
    })
    expect(spec).not.toBeNull()
    const rerouted = rerouteGateShape(simIntent, DRUG_QUESTION, criteria)
    expect(rerouted).not.toBeNull()
    expect(rerouted!.mode).toBe('sweep_filter')
    expect(rerouted!.metricKeys[0]).toBe('median_gross_rent')
  })

  it('a genuine similarity question (named reference place) is never re-routed or gated', () => {
    const q = 'places similar to Philadelphia with lower rent'
    const simIntent = intent({ mode: 'similarity', geographies: ['Philadelphia'] })
    const criteria = decomposeResearchCriteria(q)
    expect(detectGeographyGate({ queryText: q, intent: simIntent, researchCriteria: criteria })).toBeNull()
    expect(rerouteGateShape(simIntent, q, criteria)).toBeNull()
  })

  it('the drug specimen gates end to end under a similarity-labelled intent', async () => {
    const calls: string[] = []
    const simIntent = intent({ mode: 'similarity', metricKeys: ['median_gross_rent'] })
    const answer = await composeAnswerForRequest({
      intent: simIntent,
      queryText: DRUG_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(simIntent, INDEX),
      provider: routeShapedProvider(DRUG_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer!.geographyGate).toBeDefined()
    expect(answer!.places.map((p) => p.name)).not.toContain('Corbin, KY')
  })
})

describe('round 4: the split-residue decomposition realization', () => {
  it('detection selects the combined criterion carrying the classifying clause', () => {
    const splitCriteria = [
      {
        id: 'cost_of_living',
        label: 'Cost of living',
        text: TAX_QUESTION,
        decomposedMetricKey: 'median_gross_rent',
      },
      { id: 'combined', label: 'Gate-map criterion', text: 'gate map' },
      {
        id: 'combined',
        label: 'No income tax',
        text: 'which state has no income tax',
      },
      { id: 'combined', label: 'No sales tax', text: 'or sales tax' },
    ]
    const spec = detectGeographyGate({
      queryText: TAX_QUESTION,
      intent: intent(),
      researchCriteria: splitCriteria,
    })
    expect(spec).not.toBeNull()
    expect(spec!.criterion.label).toBe('No income tax')
  })
})

describe('round 4: a detected gate that cannot be applied is accounted, never deflected', () => {
  // The probe's own prose classes, riding the pipeline research:
  // a correct classification table, a disjointness assertion over
  // lists that overlap, a deflection to a gate map, and an
  // instruction to narrow the answer by hand.
  const DEFLECTING_PROSE =
    'Alaska has no state income tax. Oregon does not levy a sales tax. ' +
    'The two lists are disjoint. ' +
    'To narrow this to only states with no income tax or no sales tax, use the gate map below. ' +
    'Filtering the map to your chosen states would show the same places restricted to those states.'
  function failingClassificationProvider(calls: string[]) {
    return createStubProvider({
      async research(req: ResearchRequest) {
        calls.push(req.queryText)
        if (req.queryText.includes('For the state part of the question')) {
          throw new Error('shape_invalid: research needs a queryText within the ceiling')
        }
        return { prose: DEFLECTING_PROSE, sources: SOURCES }
      },
    })
  }

  it('classification lookup failure: failure entry, no met stamp for the criterion, claims dropped', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: TAX_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: failingClassificationProvider(calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    expect(answer!.geographyGate).toBeUndefined()
    expect(answer!.geographyGateFailure?.reason).toBe('the classification lookup did not return')
    const failureEntry = answer!.criterionEvidence.find(
      (e) => e.criterion === 'No income tax? or sales tax',
    )
    expect(failureEntry?.status).toBe('not_measurable')
    expect(failureEntry?.detail).toContain('could not be applied in this run')
    expect(failureEntry?.detail).toContain('not restricted to the states')
    // No other entry stamps the classifying criterion as served.
    expect(
      answer!.criterionEvidence.filter(
        (e) => e.criterion === 'No income tax? or sales tax' && e.status === 'met',
      ),
    ).toHaveLength(0)
    // The deflection / disjoint / gate-map prose never renders.
    const renderedClaims = answer!.generalClaims.map((c) => c.text).join(' ')
    expect(renderedClaims).not.toMatch(/disjoint/i)
    expect(renderedClaims).not.toMatch(/gate map/i)
    expect(renderedClaims).not.toMatch(/narrow this/i)
    expect(renderedClaims).not.toMatch(/filtering the map/i)
    expect(answer!.summary).not.toMatch(/gate map/i)
  })

  it('empty classification: the failure names that the research named no state', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: DRUG_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: routeShapedProvider('No source roundup could be compiled for this topic.', calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer!.geographyGate).toBeUndefined()
    expect(answer!.geographyGateFailure?.reason).toBe(
      'the cited research named no state meeting this criterion',
    )
    const entry = answer!.criterionEvidence.find((e) => e.criterion === 'Outside-Census criteria')
    expect(entry?.status).toBe('not_measurable')
    expect(entry?.detail).toContain('could not be applied in this run')
  })
})

describe('round 4: place-figure binding in verifyAnswer', () => {
  it('a claim naming a place at a figure its row contradicts fails verification; the row figure passes', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: DRUG_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: routeShapedProvider(DRUG_PROSE, calls),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    const sourceUrl = answer!.sources[0]!.url
    const wrong = {
      ...answer!,
      generalClaims: [
        { text: 'Bridgeport, CA has a median gross rent of $1,025/mo.', sourceUrls: [sourceUrl] },
      ],
    }
    const wrongVerdict = verifyAnswer(wrong, ROWS)
    expect(wrongVerdict.ok).toBe(false)
    expect(wrongVerdict.failures.join(' ')).toContain('not bound to named place')
    const right = {
      ...answer!,
      generalClaims: [
        { text: 'Bridgeport, CA has a median gross rent of $225/mo.', sourceUrls: [sourceUrl] },
      ],
    }
    expect(verifyAnswer(right, ROWS).ok).toBe(true)
    // And in the summary surface: a figure bound to a DIFFERENT
    // named place in the same sentence passes; an unbound one fails.
    const summaryWrong = {
      ...answer!,
      summary: `${answer!.summary} Bridgeport, CA is listed at $1,025/mo.`,
    }
    expect(verifyAnswer(summaryWrong, ROWS).ok).toBe(false)
  })
})
