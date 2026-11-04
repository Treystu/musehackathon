import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { composeAnswer, type ScreenResult } from '../../src/core/ai/answer'
import type { GeographyGateContext } from '../../src/core/ai/geography-gate'
import { gateMapModel } from '../../src/core/map/gate-map'

const TAX_QUESTION =
  'which state has no income tax? or sales tax? and for those states, which zip codes have the lowest cost of living?'

/**
 * Geography-gate round 5 (2026-11-04): bound-set consistency
 * across screen, standings, and map. The live specimen on
 * b6701b9 gated correctly — per-part lists right, screen inside
 * the 12-state union — yet its gate map colored North Dakota
 * (in neither list) and not Washington (in the income list), and
 * a North Dakota place sat in the results. The RCA (record:
 * DRUG-LAW-GATE-R5.md) found no single derivation to check the
 * surfaces against: the bound, the gate record's standings, and
 * the display each re-derived a row's state from its display
 * name's suffix at a different seam, so their agreement was
 * emergent. These pins hold the cured construction: the bound's
 * attribution is derived ONCE (gateBoundAttribution) and threaded
 * to compose, whose standings group by the state that ADMITTED
 * each ZCTA; the map's state set then equals the bound set by
 * construction. The border-ZCTA case is shaped on ZIP 58538
 * (Standing Rock: the ZIP area crosses the ND/SD line; the place
 * index assigns it to North Dakota, the state of its place —
 * Cannon Ball — and the answer's geography note states that
 * assignment rule).
 */

const TOWNS: { town: string; state: string; zip: string; rent: number }[] = [
  { town: 'Little Eagle', state: 'SD', zip: '56589', rent: 244 },
  { town: 'Albany', state: 'TX', zip: '76430', rent: 265 },
  { town: 'Ekalaka', state: 'MT', zip: '59324', rent: 275 },
  { town: 'Caryville', state: 'FL', zip: '32427', rent: 285 },
  { town: 'Caliente', state: 'NV', zip: '89008', rent: 295 },
  { town: 'Orlinda', state: 'TN', zip: '37141', rent: 305 },
  { town: 'Kaycee', state: 'WY', zip: '82639', rent: 315 },
  { town: 'Ketchikan', state: 'AK', zip: '99901', rent: 325 },
  { town: 'Seaford', state: 'DE', zip: '19973', rent: 335 },
  { town: 'Lisbon', state: 'NH', zip: '03585', rent: 345 },
  { town: 'Ashland', state: 'OR', zip: '97520', rent: 355 },
  { town: 'Selby', state: 'SD', zip: '57472', rent: 500 },
  // In the bound (no income tax) but far above the leaders: no
  // shown place, yet its standing and its map color must exist.
  { town: 'Moclips', state: 'WA', zip: '98562', rent: 900 },
  // The border ZIP area: crosses the ND/SD line, assigned by the
  // index to ND (its place, Cannon Ball). ND is in NEITHER tax
  // list, so this row is outside the specimen's bound — at $351
  // it would displace Ashland from the shown ten if admitted.
  { town: 'Cannon Ball', state: 'ND', zip: '58538', rent: 351 },
  // The national cheapest, outside every classified set.
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
  metrics: {
    median_gross_rent: t.rent,
    median_household_income: 60000,
    population: 100,
  },
  moes: { median_gross_rent: 40 },
}))

function intent(partial: Partial<ValidatedIntent> = {}): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_household_income'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

const TAX_PROSE =
  'Nine states have no state income tax: Alaska, Florida, Nevada, New Hampshire, South Dakota, Tennessee, Texas, Washington, and Wyoming. ' +
  'Five states have no statewide sales tax: Alaska, Delaware, Montana, New Hampshire, and Oregon. ' +
  'Alaska and New Hampshire appear on both lists.'

const MIRROR_PROSE =
  'North Dakota has no state income tax. South Dakota has no state income tax. ' +
  'South Dakota has no statewide sales tax.'

function scriptedProvider(classificationProse: string) {
  return createStubProvider({
    async research(req: ResearchRequest) {
      if (req.queryText.includes('For the state part of the question')) {
        return {
          prose: classificationProse,
          sources: [{ title: 'State tax roundup', url: 'https://example.org/tax-roundup' }],
        }
      }
      const places = req.places ?? []
      return {
        prose: places.map((p) => `${p} is noted for its housing costs.`).join(' '),
        sources: [{ title: 'Local guide', url: 'https://example.org/guide' }],
      }
    },
  })
}

const UNION = ['AK', 'DE', 'FL', 'MT', 'NV', 'NH', 'OR', 'SD', 'TN', 'TX', 'WA', 'WY']
const BASEMAP_STATES = [
  ...UNION.map((code) => ({ code, name: code })),
  { code: 'ND', name: 'North Dakota' },
  { code: 'KY', name: 'Kentucky' },
]

describe('geography gate round 5: bound-set consistency', () => {
  it('the tax specimen: standings and map cover exactly the bound — every bound state rendered, no non-bound state colored, the border ZIP area outside', async () => {
    const preliminaries: import('../../src/core/ai/answer').ComposedAnswer[] = []
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: TAX_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(TAX_PROSE),
      research: true,
      placeIndex: INDEX,
      stack: false,
      onPreliminary: (a) => preliminaries.push(a),
    })
    expect(answer).not.toBeNull()
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(UNION)

    // The screen ran inside the union only: 13 in-bound rows; the
    // border ZIP area (assigned to ND, in neither list) and the
    // national cheapest (KY) are both outside it.
    expect(answer!.screenedCount).toBe(13)
    const names = answer!.places.map((p) => p.name)
    expect(names).not.toContain('Cannon Ball, ND')
    expect(names).not.toContain('Corbin, KY')
    expect(answer!.places.some((p) => p.zcta === '58538')).toBe(false)
    expect(names[0]).toBe('Little Eagle, SD')

    // The invariant: the standings' state set EQUALS the bound
    // set — every bound state present, no other state present.
    expect(gate!.standings.map((s) => s.code)).toEqual(UNION)
    // Washington is valued from the full bounded screen even
    // though its only place sits far outside the shown ten.
    const topTen = [...answer!.places]
      .sort(
        (a, b) =>
          (a.figures.find((f) => f.key === 'median_gross_rent')?.value ?? 0) -
          (b.figures.find((f) => f.key === 'median_gross_rent')?.value ?? 0),
      )
      .slice(0, 10)
      .map((p) => p.name)
    expect(topTen).not.toContain('Moclips, WA')
    const wa = gate!.standings.find((s) => s.code === 'WA')
    expect(wa?.cheapestRent).toBe(900)
    expect(wa?.cheapestPlaceName).toBe('Moclips, WA')
    expect(gate!.standings.find((s) => s.code === 'SD')?.cheapestRent).toBe(244)

    // The map frames exactly the bound: all 12 valued, ND and KY
    // outside the frame, the winner state is the cheapest
    // standing's (SD).
    const model = gateMapModel(answer!, BASEMAP_STATES)
    expect(model).not.toBeNull()
    const byCode = new Map(model!.states.map((s) => [s.code, s]))
    for (const code of UNION) expect(byCode.get(code)?.stateClass).toBe('valued')
    expect(byCode.get('ND')?.stateClass).toBe('outside')
    expect(byCode.get('KY')?.stateClass).toBe('outside')
    expect(model!.winnerCode).toBe('SD')
    expect(model!.cheapest).toEqual({ placeName: 'Little Eagle, SD', stateName: 'South Dakota', value: 244 })

    // The bound's assignment rule is stated on the answer, so a
    // border ZIP area's absence is explicable from the stated
    // bound alone.
    expect(answer!.geographyDisclosures.join(' ')).toContain(
      'ZIP areas are counted in the state of the place they belong to',
    )

    // The preliminary ran under the same bound and the same
    // record construction.
    expect(preliminaries).toHaveLength(1)
    expect(preliminaries[0]!.screenedCount).toBe(13)
    expect(preliminaries[0]!.geographyGate?.standings.map((s) => s.code)).toEqual(UNION)
  })

  it('the border ZIP area under its own state: a bound containing ND admits it, counts it toward ND, and colors ND', async () => {
    const answer = await composeAnswerForRequest({
      intent: intent(),
      queryText: TAX_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(), INDEX),
      provider: scriptedProvider(MIRROR_PROSE),
      research: true,
      placeIndex: INDEX,
      stack: false,
    })
    expect(answer).not.toBeNull()
    const gate = answer!.geographyGate
    expect(gate).toBeDefined()
    expect(gate!.boundStates.map((s) => s.code)).toEqual(['ND', 'SD'])
    expect(answer!.screenedCount).toBe(3)
    expect(answer!.places.map((p) => p.name)).toContain('Cannon Ball, ND')
    const nd = gate!.standings.find((s) => s.code === 'ND')
    expect(nd?.cheapestRent).toBe(351)
    expect(nd?.cheapestPlaceName).toBe('Cannon Ball, ND')
    const model = gateMapModel(answer!, BASEMAP_STATES)
    const byCode = new Map(model!.states.map((s) => [s.code, s]))
    expect(byCode.get('ND')?.stateClass).toBe('valued')
    expect(byCode.get('SD')?.stateClass).toBe('valued')
    expect(byCode.get('WA')?.stateClass).toBe('outside')
  })

  it('compose seam: standings follow the bound attribution, not the display suffix, when the two diverge', () => {
    // Hypothesis (b)'s exact shape, at the seam where it would
    // bite: a screened row whose ZCTA the bound's attribution
    // assigns to SD while its display name reads ND. With the
    // attribution supplied (the runner's construction), the row
    // counts toward its ADMITTING state; without one, the shipped
    // suffix fallback counts it toward ND — which has no standing
    // here — and SD's standing misses it. The divergence between
    // the two runs is the defect class this round closes on the
    // shipped path.
    const rows: AreaRow[] = [
      { zcta: '58538', name: 'Cannon Ball, ND', metrics: { median_gross_rent: 200 }, moes: { median_gross_rent: 30 } },
      { zcta: '56589', name: 'Little Eagle, SD', metrics: { median_gross_rent: 244 }, moes: { median_gross_rent: 40 } },
    ]
    const screen: ScreenResult = {
      criteria: [],
      droppedCriteria: [],
      unresolvedGeographies: [],
      inScopeCount: rows.length,
      rows,
    }
    const gate: GeographyGateContext = {
      criterionId: 'combined-tax',
      criterionLabel: 'No income tax',
      criterionText: 'which state has no income tax',
      boundStates: [{ code: 'SD', name: 'South Dakota' }],
      classifiedStates: [{ code: 'SD', name: 'South Dakota' }],
      winnerState: null,
      claims: [],
      sources: [],
    }
    const attribution = new Map([
      ['58538', { code: 'SD', name: 'South Dakota' }],
      ['56589', { code: 'SD', name: 'South Dakota' }],
    ])
    const withAttribution = composeAnswer({
      intent: intent({ metricKeys: ['median_gross_rent'] }),
      screen,
      geographyGate: gate,
      geographyGateAttribution: attribution,
    })
    const record = withAttribution.geographyGate
    expect(record).toBeDefined()
    expect(record!.standings.map((s) => s.code)).toEqual(['SD'])
    expect(record!.standings[0]?.cheapestRent).toBe(200)
    expect(record!.standings[0]?.cheapestPlaceName).toBe('Cannon Ball, ND')
    expect(record!.standings[0]?.cheapestZcta).toBe('58538')
    const model = gateMapModel(withAttribution, [
      { code: 'SD', name: 'South Dakota' },
      { code: 'ND', name: 'North Dakota' },
    ])
    expect(model!.states.find((s) => s.code === 'SD')?.stateClass).toBe('valued')
    expect(model!.states.find((s) => s.code === 'ND')?.stateClass).toBe('outside')

    const withoutAttribution = composeAnswer({
      intent: intent({ metricKeys: ['median_gross_rent'] }),
      screen,
      geographyGate: gate,
    })
    expect(withoutAttribution.geographyGate!.standings[0]?.cheapestRent).toBe(244)
  })
})
