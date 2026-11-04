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

/**
 * Geography-gate traversal (drug-law specimen cure, 2026-11-04):
 * the full runner -> pipeline path on the specimen's question
 * class. The pre-cure specimen screened all 33,791 places
 * nationally, listed the country's cheapest rents (Corbin, KY at
 * the head — a state its own research excludes), and rendered the
 * state classification as a footnote. These pins hold the cured
 * order: the classification research runs FIRST, the screen's bound
 * is exactly the qualifying set, both winners are named in the
 * lead, the criteria labels are honest, and the counter-controls
 * (per-place criterion; empty classification) keep the shipped
 * flow.
 */
const SPECIMEN =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'

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

/** A mini-country: the national cheapest (KY, MS) sit OUTSIDE the
 * classified set; the in-set states carry their own cheap places. */
const ROWS: AreaRow[] = [
  { zcta: '40771', name: 'Corbin, KY', metrics: { median_gross_rent: 99 }, moes: { median_gross_rent: 10 } },
  { zcta: '40201', name: 'Louisville, KY', metrics: { median_gross_rent: 900 }, moes: { median_gross_rent: 40 } },
  { zcta: '39338', name: 'Louin, MS', metrics: { median_gross_rent: 130 }, moes: { median_gross_rent: 14 } },
  { zcta: '93517', name: 'Bridgeport, CA', metrics: { median_gross_rent: 225 }, moes: { median_gross_rent: 92 } },
  { zcta: '95965', name: 'Oroville, CA', metrics: { median_gross_rent: 700 }, moes: { median_gross_rent: 40 } },
  { zcta: '90001', name: 'Los Angeles, CA', metrics: { median_gross_rent: 1500 }, moes: { median_gross_rent: 50 } },
  { zcta: '62931', name: 'Elizabethtown, IL', metrics: { median_gross_rent: 235 }, moes: { median_gross_rent: 63 } },
  { zcta: '60601', name: 'Chicago, IL', metrics: { median_gross_rent: 1400 }, moes: { median_gross_rent: 60 } },
  { zcta: '56591', name: 'White Earth, MN', metrics: { median_gross_rent: 198 }, moes: { median_gross_rent: 160 } },
  { zcta: '80301', name: 'Boulder, CO', metrics: { median_gross_rent: 1800 }, moes: { median_gross_rent: 70 } },
  { zcta: '81224', name: 'Crested Butte, CO', metrics: { median_gross_rent: 210 }, moes: { median_gross_rent: 30 } },
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

const ROUNDUP_SOURCES = [
  { title: 'State cannabis policy roundup', url: 'https://example.org/cannabis-roundup' },
  { title: 'Recreational legalization by state', url: 'https://example.org/legal-states' },
]

/** Research stub: the classification ask gets the roundup prose;
 * every later (per-place) call gets a generic claim per place. */
function scriptedProvider(classificationProse: string, calls: string[]) {
  return createStubProvider({
    async research(req: ResearchRequest) {
      calls.push(req.queryText)
      if (req.queryText.includes('For the state part of the question')) {
        return { prose: classificationProse, sources: ROUNDUP_SOURCES }
      }
      const places = req.places ?? []
      return {
        prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
        sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
      }
    },
  })
}

const CLASS_PROSE =
  'Recreational marijuana is fully legal in California, Illinois, and Minnesota. ' +
  'It is also legal in Oregon and Colorado. ' +
  'Marijuana remains illegal in Kentucky and Mississippi.'

describe('geography gate traversal: the specimen shape', () => {
  it('classifies first, screens bounded to the qualifying set, names both winners', async () => {
    const calls: string[] = []
    const preliminaries: ComposedAnswer[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(CLASS_PROSE, calls),
      research: true,
      stack: false,
      onPreliminary: (a) => preliminaries.push(a),
    })
    expect(answer).not.toBeNull()
    expect(answer!.status).toBe('verified')

    // Order: the FIRST research call is the classification ask.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toContain('For the state part of the question')

    // Bound: the screen assessed exactly the in-set rows (CA 3 +
    // IL 2 + MN 1 + CO 2 = 8); the national cheapest never appear.
    expect(answer!.screenedCount).toBe(8)
    const names = answer!.places.map((p) => p.name)
    expect(names).not.toContain('Corbin, KY')
    expect(names).not.toContain('Louin, MS')
    expect(names).not.toContain('Louisville, KY')
    for (const name of names) expect(name).toMatch(/, (CA|IL|MN|CO)$/)

    // Winner composition: the lead names the qualifying class with
    // its basis and the in-set extremum (White Earth, $198 — order
    // form: its wide margin band overlaps Bridgeport's, so the
    // strong "lowest" form is not earned and is not claimed).
    expect(answer!.summary).toContain(
      "For the question's first part, the cited research classifies California, Colorado, Illinois, Minnesota, and Oregon as meeting the stated criterion",
    )
    expect(answer!.summary).toContain('California')
    expect(answer!.summary).toContain(
      "White Earth, MN heads the qualifying set's places ordered by median gross rent, lowest first",
    )

    // Criteria honesty: the classifying criterion is measured BY
    // the classification (never per-place annotation), and the
    // bound is disclosed on the card.
    const gateEntry = answer!.criterionEvidence.find((e) => e.criterion === 'Outside-Census criteria')
    expect(gateEntry?.status).toBe('met')
    expect(gateEntry?.detail).toContain('before the Census screen ran')
    expect(gateEntry?.sourceUrls).toEqual(
      expect.arrayContaining(['https://example.org/cannabis-roundup']),
    )
    expect(answer!.geographyDisclosures.join(' ')).toContain('The cost screen ran inside')

    // The classification's cited evidence rides on the card.
    expect(answer!.generalClaims.map((c) => c.text).join(' ')).toContain(
      'Recreational marijuana is fully legal in California, Illinois, and Minnesota.',
    )

    // The gate record: standings per bound state (cheapest screened
    // place each), nulls where a classified state has no rows here.
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.winnerState).toBeNull()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['CA', 'CO', 'IL', 'MN', 'OR'])
    const standing = (code: string) => gate!.standings.find((s) => s.code === code)
    expect(standing('CA')?.cheapestPlaceName).toBe('Bridgeport, CA')
    expect(standing('CA')?.cheapestRent).toBe(225)
    expect(standing('IL')?.cheapestPlaceName).toBe('Elizabethtown, IL')
    expect(standing('MN')?.cheapestPlaceName).toBe('White Earth, MN')
    expect(standing('CO')?.cheapestPlaceName).toBe('Crested Butte, CO')
    expect(standing('OR')?.cheapestRent).toBeNull()

    // Preliminary staging: the gate's preliminary carries the
    // classification evidence as landed (met, not pending) over the
    // same bounded screen.
    expect(preliminaries.length).toBe(1)
    const preliminary = preliminaries[0]!
    expect(preliminary.preliminary).toBe(true)
    expect(preliminary.screenedCount).toBe(8)
    const prelimGate = preliminary.criterionEvidence.find(
      (e) => e.criterion === 'Outside-Census criteria',
    )
    expect(prelimGate?.status).toBe('met')
  })

  it('bounds to the singled-out winner state when the research names one', async () => {
    const calls: string[] = []
    const winnerProse =
      'Recreational marijuana is fully legal in California, Illinois, Minnesota, and Colorado. ' +
      'Several sources describe Colorado as having the most relaxed drug laws in the country, with legal retail sales since 2014.'
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(winnerProse, calls),
      research: true,
      stack: false,
    })
    expect(answer!.status).toBe("verified")
    expect(answer!.screenedCount).toBe(2)
    expect(answer!.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Crested Butte, CO', 'Boulder, CO']),
    )
    expect(answer!.summary).toContain(
      "the cited research singles out Colorado as the state meeting the stated criterion most strongly",
    )
    // Crested Butte $210 ±30 vs Boulder $1800 ±70: bands disjoint,
    // so the strong form is earned.
    expect(answer!.summary).toContain(
      'Crested Butte, CO has the lowest median gross rent in the qualifying set',
    )
    expect(answer!.geographyGate?.winnerState?.code).toBe('CO')
    expect(answer!.geographyGate?.boundStates.map((s) => s.code)).toEqual(['CO'])
  })

  it('keeps the shipped flow when the classification comes back empty', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider('No state-by-state characterization was found.', calls),
      research: true,
      stack: false,
    })
    expect(answer!.status).toBe("verified")
    expect(answer!.geographyGate).toBeUndefined()
    expect(answer!.screenedCount).toBe(ROWS.length)
    expect(answer!.places.map((p) => p.name)).toContain('Corbin, KY')
  })
})

describe('geography gate counter-control: per-place researched criterion', () => {
  it('a beer-selection question never engages the gate', async () => {
    const calls: string[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: 'which city has good beer selection and low rent?',
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(CLASS_PROSE, calls),
      research: true,
      stack: false,
    })
    expect(answer!.status).toBe("verified")
    expect(answer!.geographyGate).toBeUndefined()
    // No classification ask was ever issued.
    expect(calls.every((q) => !q.includes('For the state part of the question'))).toBe(true)
    // The shipped per-place flow: the national screen stands.
    expect(answer!.screenedCount).toBe(ROWS.length)
    expect(answer!.places.map((p) => p.name)).toContain('Corbin, KY')
  })
})
