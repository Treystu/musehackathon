import { describe, expect, it } from 'vitest'
import { criterionEvidenceFor, decomposeResearchCriteria } from '../../src/core/ai/answer'
import {
  classifyStatesFromResearch,
  detectGeographyGate,
  gateClassificationQueryText,
  stateCountPhrase,
  type GeographyGateContext,
} from '../../src/core/ai/geography-gate'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * Geography-gate round 2 (2026-11-04): classification robustness.
 * Live on 2e04268 the gate mechanism worked (the screen ran inside
 * the classified set) but the classification itself collapsed to
 * ONE state: the research prose centered its narrative on Oregon
 * (decriminalization) and the round-1 sentence classifier followed
 * the focus, even though the prose carried the favorable class as
 * an enumeration. These pins hold the cure: the classification ask
 * requires the domain-wide enumeration, and the classifier honors
 * an announced (counted/listed) class as a class — while prose
 * that genuinely supports only a narrow class still classifies
 * narrowly.
 */
const SPECIMEN =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'

const specimenIntent = {
  geographies: [] as string[],
  metricKeys: ['median_gross_rent'],
  mode: 'sweep_filter' as const,
}

const spec = detectGeographyGate({
  queryText: SPECIMEN,
  intent: specimenIntent,
  researchCriteria: decomposeResearchCriteria(SPECIMEN),
})!

describe('gateClassificationQueryText (round 2)', () => {
  it('requires the domain-wide enumeration, not a focus', () => {
    const q = gateClassificationQueryText(SPECIMEN, spec)
    expect(q.startsWith(SPECIMEN)).toBe(true)
    // The runner/traversal stub keys on this opener; it is stable.
    expect(q).toContain('For the state part of the question')
    expect(q).toContain('state by state')
    expect(q).toContain('enumerate every U.S. state')
    expect(q).toContain('rather than focusing on any single state')
    expect(q).toContain('name any single state the sources identify as the strongest example')
  })
})

/**
 * The live failure shape, reconstructed: narrative sentences about
 * Oregon (which classify Oregon on their own), then the favorable
 * class carried as a counted lead + colon lead + one comma-run
 * list whose items carry no marker of their own.
 */
const OREGON_FOCUSED =
  'Oregon has long been a pioneer on drug policy. ' +
  'Oregon decriminalized possession of small amounts of drugs in 2020, a first-in-the-nation step that drew national attention. ' +
  'Much of the coverage of relaxed drug laws centers on Oregon and its decriminalization experiment. ' +
  'As of 2025, recreational marijuana is fully legal in 24 states. ' +
  'The states where recreational marijuana is fully legal include: ' +
  'Alaska, Arizona, California, Colorado, Connecticut, Delaware, Illinois, Maine, Maryland, Massachusetts, Michigan, Minnesota, Missouri, Montana, Nevada, New Jersey, New Mexico, New York, Ohio, Oregon, Rhode Island, Vermont, Virginia, and Washington. ' +
  'Marijuana remains illegal in Idaho and Wyoming.'

describe('classifyStatesFromResearch — enumerated class outranks focus (round 2)', () => {
  it('classifies the enumerated class, not Oregon alone', () => {
    const result = classifyStatesFromResearch(OREGON_FOCUSED, spec)
    const codes = result.favorableStates.map((s) => s.code)
    expect(codes.length).toBe(24)
    expect(codes).toEqual(
      expect.arrayContaining(['AK', 'CA', 'CO', 'IL', 'MN', 'NJ', 'NY', 'OR', 'WA']),
    )
    expect(codes).not.toContain('ID')
    expect(codes).not.toContain('WY')
    // The prose singles out no state as the strongest: no winner.
    expect(result.winnerState).toBeNull()
    // The enumeration sentences ride as cited claims.
    expect(result.claims.join(' ')).toContain('fully legal in 24 states')
    expect(result.claims.join(' ')).toContain('Alaska, Arizona, California')
  })

  it('collects a headed bare list under a colon lead-in', () => {
    const prose =
      'Coverage of the issue tends to focus on Oregon, which decriminalized marijuana possession back in 1973. ' +
      'States where recreational marijuana is fully legal:\n' +
      'California\nColorado\nIllinois\nMinnesota\n' +
      'In Idaho, by contrast, marijuana remains illegal.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['CA', 'CO', 'IL', 'MN', 'OR'])
    expect(result.winnerState).toBeNull()
  })

  it('keeps a genuinely narrow classification narrow (no invention)', () => {
    const prose =
      'Oregon decriminalized possession of small amounts in 1973 and remains the focus of the national decriminalization debate. ' +
      'No other state has adopted the same approach, and marijuana remains illegal in Idaho and Wyoming.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['OR'])
    expect(result.winnerState).toBeNull()
  })

  it('keeps the round-1 enumerated prose behavior unchanged', () => {
    // The round-1 fixture shape (geography-gate.test.ts ROUNDUP):
    // a list sentence carrying its own marker, a winner sentence, a
    // contrast sentence. The enumeration pass must not move it.
    const roundup =
      'As of 2025, recreational marijuana is fully legal in California, Illinois, Minnesota, Colorado, and Oregon. ' +
      'Texas and Florida have not legalized recreational use, and marijuana remains illegal in Idaho. ' +
      'Several sources describe Colorado as having the most relaxed drug laws in the country, with legal retail sales since 2014. ' +
      'In Wyoming, by contrast, the drug is illegal and possession is criminalized.'
    const result = classifyStatesFromResearch(roundup, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['CA', 'CO', 'IL', 'MN', 'OR'])
    expect(result.winnerState?.code).toBe('CO')
  })

  it('honors an announced enumeration on the flipped (restrictive) pole', () => {
    const strictSpec = detectGeographyGate({
      queryText:
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      intent: specimenIntent,
      researchCriteria: decomposeResearchCriteria(
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      ),
    })!
    const prose =
      'States where marijuana remains illegal include: Idaho, Wyoming, and Nebraska. ' +
      'Recreational use is legal in Colorado.'
    const result = classifyStatesFromResearch(prose, strictSpec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['ID', 'NE', 'WY'])
    expect(result.favorableStates.map((s) => s.code)).not.toContain('CO')
  })
})

describe('stateCountPhrase + gate evidence agreement (round 2)', () => {
  it('agrees with its count for any count', () => {
    expect(stateCountPhrase(1)).toBe('1 state')
    expect(stateCountPhrase(2)).toBe('2 states')
    expect(stateCountPhrase(24)).toBe('24 states')
    expect(stateCountPhrase(51)).toBe('51 states')
  })

  function gateContext(partial: Partial<GeographyGateContext>): GeographyGateContext {
    return {
      criterionId: 'combined',
      criterionLabel: 'Outside-Census criteria',
      criterionText: 'most relaxed drug laws',
      boundStates: [],
      classifiedStates: [],
      winnerState: null,
      claims: [],
      sources: [{ title: 'State cannabis laws roundup', url: 'https://example.org/roundup' }],
      ...partial,
    }
  }

  function gateDetail(ctx: GeographyGateContext): string {
    const evidence = criterionEvidenceFor({
      criteria: [],
      droppedCriteria: [],
      researchCriteria: [],
      places: [],
      claims: [],
      unsupportedGeography: null,
      geographyGate: ctx,
    })
    return evidence.find((e) => e.criterion === 'Outside-Census criteria')?.detail ?? ''
  }

  it('renders the singular over a one-state class (the live slip)', () => {
    const oregon = [{ code: 'OR', name: 'Oregon' }]
    const detail = gateDetail(
      gateContext({ boundStates: oregon, classifiedStates: oregon, winnerState: null }),
    )
    expect(detail).toContain('the research classifies 1 state as meeting this criterion (Oregon)')
    expect(detail).toContain('the cost screen ran inside that 1 state')
    expect(detail).not.toContain('1 states')
  })

  it('keeps the plural over a multi-state class', () => {
    const two = [
      { code: 'CA', name: 'California' },
      { code: 'OR', name: 'Oregon' },
    ]
    const detail = gateDetail(
      gateContext({ boundStates: two, classifiedStates: two, winnerState: null }),
    )
    expect(detail).toContain('the research classifies 2 states as meeting this criterion')
    expect(detail).toContain('the cost screen ran inside those 2 states')
  })

  it('renders the singular in the winner variant too', () => {
    const oregon = { code: 'OR', name: 'Oregon' }
    const detail = gateDetail(
      gateContext({
        boundStates: [oregon],
        classifiedStates: [oregon],
        winnerState: oregon,
      }),
    )
    expect(detail).toContain('among the 1 state it classifies as meeting it (Oregon)')
    expect(detail).not.toContain('1 states')
  })
})

describe('one-state classification traversal: the disclosure agrees too (round 2)', () => {
  const PLACES: PlaceSuggestion[] = [
    { displayName: 'Corbin', censusName: 'Corbin city', state: 'KY', isCity: true, zips: ['40771'] },
  ]
  const BY_ZIP = new Map<string, PlaceRecord>(
    PLACES.flatMap((place) =>
      place.zips.map(
        (zip) =>
          [
            zip,
            {
              zip,
              censusName: place.censusName,
              displayName: place.displayName,
              state: place.state,
              isCity: true,
              incorporated: true,
            },
          ] as const,
      ),
    ),
  )
  const INDEX = new PlaceIndex(BY_ZIP, PLACES)
  const ROWS: AreaRow[] = [
    { zcta: '40771', name: 'Corbin, KY', metrics: { median_gross_rent: 99 }, moes: { median_gross_rent: 10 } },
    { zcta: '97627', name: 'Juntura, OR', metrics: { median_gross_rent: 275 }, moes: { median_gross_rent: 40 } },
    { zcta: '97701', name: 'Bend, OR', metrics: { median_gross_rent: 1200 }, moes: { median_gross_rent: 60 } },
    { zcta: '93517', name: 'Bridgeport, CA', metrics: { median_gross_rent: 225 }, moes: { median_gross_rent: 92 } },
  ]
  const intent = (partial: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  })

  it('bounds to the single classified state and says "1 state" everywhere', async () => {
    const calls: string[] = []
    const provider = createStubProvider({
      async research(req: ResearchRequest) {
        calls.push(req.queryText)
        if (req.queryText.includes('For the state part of the question')) {
          return {
            prose:
              'Oregon decriminalized possession of small amounts in 1973. ' +
              'Recreational marijuana is fully legal in Oregon.',
            sources: [{ title: 'State cannabis laws roundup', url: 'https://example.org/roundup' }],
          }
        }
        const places = req.places ?? []
        return {
          prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
          sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider,
      research: true,
      stack: false,
    })
    expect(answer).not.toBeNull()
    expect(answer!.status).toBe('verified')
    expect(answer!.geographyGate?.classifiedStates.map((s) => s.code)).toEqual(['OR'])
    expect(answer!.screenedCount).toBe(2)
    expect(answer!.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Juntura, OR', 'Bend, OR']),
    )
    const disclosures = answer!.geographyDisclosures.join(' ')
    expect(disclosures).toContain(
      "The cost screen ran inside the 1 state the cited research classifies as meeting the question's first criterion: Oregon.",
    )
    expect(disclosures).not.toContain('1 states')
    const gateEntry = answer!.criterionEvidence.find((e) => e.criterion === 'Outside-Census criteria')
    expect(gateEntry?.detail).toContain('classifies 1 state as meeting this criterion')
    expect(gateEntry?.detail).not.toContain('1 states')
  })
})
