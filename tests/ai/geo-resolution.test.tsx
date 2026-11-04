// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import {
  PlaceIndex,
  type PlaceRecord,
  type PlaceSuggestion,
} from '../../src/core/zcta-place-index'
import {
  CountyIndex,
  type CountyGroup,
  type CountyRecord,
} from '../../src/core/zcta-county-index'

/**
 * P2 geography resolution pins (recompiled plan phase P2, 2026-11-02):
 * one battery-shaped test per cure, over fixture indexes whose
 * arithmetic is checkable by hand.
 *
 *   D2  "Portland, OR" in a sweep widened to the whole state of
 *       Oregon (Eugene and Salem answered for Portland) because the
 *       state suffix was tried before the city search.
 *   C3  "Boulder County" resolved through the place index to the
 *       single county-fallback ZIP 80471, whose income ($41,000)
 *       was aggregated alone under the county name; over ALL member
 *       ZIPs the population-weighted figure is about $81,930.
 *   C4  "Denver County" resolved to nothing and was dropped from a
 *       comparison with no disclosure.
 *   C6  "Hawaii" as a comparison geography resolved by place-name
 *       search to Hawaiian Acres, which silently occupied the
 *       state-average slot.
 *   B6  "Midwest" resolved to the town of Midwest, WY.
 *   B3  Research named 3 places; Corbin, KY split into both of its
 *       ZIPs and both were counted ("named 4"), including the
 *       claimless 40771.
 */

const PLACES: PlaceSuggestion[] = [
  { displayName: 'Portland', censusName: 'Portland city', state: 'OR', isCity: true, zips: ['97201', '97205'] },
  { displayName: 'Eugene', censusName: 'Eugene city', state: 'OR', isCity: true, zips: ['97401'] },
  { displayName: 'Salem', censusName: 'Salem city', state: 'OR', isCity: true, zips: ['97301'] },
  { displayName: 'Boulder', censusName: 'Boulder city', state: 'CO', isCity: true, zips: ['80301', '80302'] },
  // The county-fallback record the place index carries for 80471:
  // the stand-in the old resolution returned for "Boulder County".
  { displayName: 'Boulder County', censusName: 'Boulder County', state: 'CO', isCity: false, zips: ['80471'] },
  { displayName: 'Denver', censusName: 'Denver city', state: 'CO', isCity: true, zips: ['80202', '80203'] },
  { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720'] },
  { displayName: 'Keaau', censusName: 'Keaau CDP', state: 'HI', isCity: true, zips: ['96749'] },
  { displayName: 'Honolulu', censusName: 'Honolulu city', state: 'HI', isCity: true, zips: ['96813'] },
  { displayName: 'Hawaiian Acres', censusName: 'Hawaiian Acres CDP', state: 'HI', isCity: true, zips: ['96760'] },
  { displayName: 'Midwest', censusName: 'Midwest town', state: 'WY', isCity: true, zips: ['82643'] },
  { displayName: 'Chicago', censusName: 'Chicago city', state: 'IL', isCity: true, zips: ['60601'] },
  { displayName: 'Des Moines', censusName: 'Des Moines city', state: 'IA', isCity: true, zips: ['50301'] },
  { displayName: 'Corbin', censusName: 'Corbin city', state: 'KY', isCity: true, zips: ['40701', '40771'] },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['73301'] },
]

const PLACE_INDEX = new PlaceIndex(
  new Map<string, PlaceRecord>(
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
              isCity: place.isCity,
              incorporated: true,
            },
          ] as const,
      ),
    ),
  ),
  PLACES,
)

const COUNTY_GROUPS: CountyGroup[] = [
  { censusName: 'Boulder County', state: 'CO', zips: ['80301', '80302', '80471'] },
  { censusName: 'Denver County', state: 'CO', zips: ['80202', '80203'] },
]

function countyIndex(groups: CountyGroup[]): CountyIndex {
  return new CountyIndex(
    new Map<string, CountyRecord>(
      groups.flatMap((group) =>
        group.zips.map(
          (zip) => [zip, { zip, censusName: group.censusName, state: group.state }] as const,
        ),
      ),
    ),
    groups,
  )
}

const COUNTY_INDEX = countyIndex(COUNTY_GROUPS)
/** The crosswalk as it would be if Denver County were absent from it. */
const BOULDER_ONLY_COUNTY_INDEX = countyIndex([COUNTY_GROUPS[0]!])

const ROWS: AreaRow[] = [
  // Portland, OR + the two Oregon cities the widening served instead.
  { zcta: '97201', name: 'ZCTA5 97201', metrics: { median_gross_rent: 1500, population: 20000 }, moes: { median_gross_rent: 60 } },
  { zcta: '97205', name: 'ZCTA5 97205', metrics: { median_gross_rent: 1550, population: 18000 }, moes: { median_gross_rent: 65 } },
  { zcta: '97401', name: 'ZCTA5 97401', metrics: { median_gross_rent: 1200, population: 25000 }, moes: { median_gross_rent: 55 } },
  { zcta: '97301', name: 'ZCTA5 97301', metrics: { median_gross_rent: 1300, population: 22000 }, moes: { median_gross_rent: 50 } },
  // Colorado: Boulder County members 80301 / 80302 / 80471, Denver 80202 / 80203.
  { zcta: '80301', name: 'ZCTA5 80301', metrics: { median_household_income: 90000, median_gross_rent: 1800, median_home_value: 850000, population: 30000 }, moes: { median_household_income: 4000, median_gross_rent: 100, median_home_value: 40000 } },
  { zcta: '80302', name: 'ZCTA5 80302', metrics: { median_household_income: 70000, median_gross_rent: 1600, median_home_value: 700000, population: 10000 }, moes: { median_household_income: 3500, median_gross_rent: 80, median_home_value: 35000 } },
  { zcta: '80471', name: 'ZCTA5 80471', metrics: { median_household_income: 41000, median_gross_rent: 900, median_home_value: 280000, population: 3000 }, moes: { median_household_income: 2100, median_gross_rent: 45, median_home_value: 14000 } },
  { zcta: '80202', name: 'ZCTA5 80202', metrics: { median_household_income: 65000, median_gross_rent: 1500, median_home_value: 550000, population: 20000 }, moes: { median_household_income: 3000, median_gross_rent: 60, median_home_value: 25000 } },
  { zcta: '80203', name: 'ZCTA5 80203', metrics: { median_household_income: 75000, median_gross_rent: 1700, median_home_value: 600000, population: 20000 }, moes: { median_household_income: 3200, median_gross_rent: 60, median_home_value: 28000 } },
  // Hawaii: burden figures the state average is weighted from.
  { zcta: '96720', name: 'ZCTA5 96720', metrics: { median_rent_burden_pct: 32, median_gross_rent: 1450, population: 45000 }, moes: { median_rent_burden_pct: 3, median_gross_rent: 52 } },
  { zcta: '96749', name: 'ZCTA5 96749', metrics: { median_rent_burden_pct: 35, median_gross_rent: 1500, population: 20000 }, moes: { median_rent_burden_pct: 3, median_gross_rent: 70 } },
  { zcta: '96813', name: 'ZCTA5 96813', metrics: { median_rent_burden_pct: 30, median_gross_rent: 1800, population: 30000 }, moes: { median_rent_burden_pct: 2, median_gross_rent: 90 } },
  { zcta: '96760', name: 'ZCTA5 96760', metrics: { median_rent_burden_pct: 45, median_gross_rent: 1100, population: 10000 }, moes: { median_rent_burden_pct: 4, median_gross_rent: 55 } },
  // Midwest region members + the same-named Wyoming town.
  { zcta: '60601', name: 'ZCTA5 60601', metrics: { median_home_value: 250000, median_household_income: 70000, population: 20000 }, moes: { median_home_value: 12000 } },
  { zcta: '50301', name: 'ZCTA5 50301', metrics: { median_home_value: 180000, median_household_income: 65000, population: 15000 }, moes: { median_home_value: 9000 } },
  { zcta: '82643', name: 'ZCTA5 82643', metrics: { median_home_value: 90000, median_household_income: 40000, population: 1000 }, moes: { median_home_value: 5000 } },
  // Corbin's split ZIPs + Austin (research-first counting).
  { zcta: '40701', name: 'ZCTA5 40701', metrics: { median_gross_rent: 800, population: 5000 }, moes: { median_gross_rent: 40 } },
  { zcta: '40771', name: 'ZCTA5 40771', metrics: { median_gross_rent: 700, population: 4000 }, moes: { median_gross_rent: 35 } },
  { zcta: '73301', name: 'ZCTA5 73301', metrics: { median_gross_rent: 1300, population: 20000 }, moes: { median_gross_rent: 60 } },
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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

describe('D2: "Portland, OR" resolves the city, not the state', () => {
  it('resolution returns exactly the Portland ZIP set for a sweep', () => {
    const resolved = resolveAnswerGeographies(
      intent({ geographies: ['Portland, OR'] }),
      PLACE_INDEX,
    )
    expect([...resolved.zctas].sort()).toEqual(['97201', '97205'])
    expect(resolved.unresolvedGeographies).toEqual([])
  })

  it('the composed card names Portland places only — no Eugene, no Salem', async () => {
    const geoIntent = intent({
      geographies: ['Portland, OR'],
      filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1600 }],
    })
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: 'Find places near Portland with median rent under $1,600',
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.zcta).sort()).toEqual(['97201', '97205'])
    expect(answer?.places.map((p) => p.name)).toEqual(['Portland, OR', 'Portland, OR'])
  })
})

describe('C3: Boulder County expands to ALL member ZIPs', () => {
  const QUERY = "What's the median household income in Boulder County, Colorado?"
  const geoIntent = intent({
    mode: 'lookup',
    geographies: ['Boulder County, CO'],
    metricKeys: ['median_household_income'],
  })

  it('resolution with the county index returns every member ZIP, not the fallback alone', () => {
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX, COUNTY_INDEX)
    expect([...resolved.zctas].sort()).toEqual(['80301', '80302', '80471'])
    expect(resolved.countyGeographies).toHaveLength(1)
    expect(resolved.unresolvedGeographies).toEqual([])
  })

  it('the county aggregate is the population-weighted figure over all members', async () => {
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: QUERY,
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX, COUNTY_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: COUNTY_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places).toHaveLength(1)
    const boulder = answer?.places[0]
    expect(boulder?.name).toBe('Boulder County, CO')
    expect(boulder?.memberZctas?.sort()).toEqual(['80301', '80302', '80471'])
    // (90000*30000 + 70000*10000 + 41000*3000) / 43000 — not 80471's
    // own 41000 wearing the county name.
    const expected = (90000 * 30000 + 70000 * 10000 + 41000 * 3000) / 43000
    expect(boulder?.figures[0]?.value).toBeCloseTo(expected, 6)
    expect(boulder?.figures[0]?.marginApproximate).toBe(true)
    expect(answer?.countyMethod).not.toBeNull()
  })

  it('App shape: resolution without the crosswalk is honestly unresolved, and compose completes it', async () => {
    // The answer effect resolves with the place index alone; the
    // county-named geography must not fall back to the place index
    // stand-in there, and compose — which holds the county index —
    // expands it before the unresolvable gate.
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX)
    expect(resolved.unresolvable).toBe(true)
    expect(resolved.unresolvedGeographies).toEqual(['Boulder County, CO'])
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: QUERY,
      rows: ROWS,
      resolved,
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: COUNTY_INDEX,
      stack: false,
    })
    expect(answer?.places.map((p) => p.name)).toEqual(['Boulder County, CO'])
    expect(answer?.places[0]?.memberZctas).toHaveLength(3)
    expect(answer?.unresolvedGeographies).toEqual([])
  })
})

describe('C4: a comparison side that resolves to nothing is named on the card', () => {
  const QUERY = 'Compare Denver County and Boulder County for affordability'
  const geoIntent = intent({
    mode: 'compare',
    geographies: ['Denver County, CO', 'Boulder County, CO'],
    metricKeys: ['median_gross_rent', 'median_home_value'],
  })

  it('both counties compose as aggregates when the crosswalk carries both', async () => {
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: QUERY,
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX, COUNTY_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: COUNTY_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    // Denver rent (1500,1700 at equal population) = 1600 leads the
    // Boulder aggregate (about 1691) under the boundless sort.
    expect(answer?.places.map((p) => p.name)).toEqual(['Denver County, CO', 'Boulder County, CO'])
    expect(answer?.unresolvedGeographies).toEqual([])
  })

  it('Denver-side disclosure: the missing side is named as unresolved beside the resolved side', async () => {
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX, BOULDER_ONLY_COUNTY_INDEX)
    expect(resolved.unresolvedGeographies).toEqual(['Denver County, CO'])
    expect(resolved.unresolvable).toBe(false)
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: QUERY,
      rows: ROWS,
      resolved,
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: BOULDER_ONLY_COUNTY_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Boulder County, CO'])
    // The card reads the same resolution result the runner produced:
    // the failed side rides on the answer, named, not recomputed
    // away by the screen (which previously reported nothing whenever
    // any ZCTA set was present).
    expect(answer?.unresolvedGeographies).toEqual(['Denver County, CO'])
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Denver County, CO could not be resolved')
    expect(text).toContain('named here as unresolved')
    expect(text).toContain('Boulder County, CO')
  })
})

describe('C6: Hawaii as a comparison geography takes the state path', () => {
  const QUERY = 'How does 96720 compare to the Hawaii state average for rent burden?'
  const geoIntent = intent({
    mode: 'compare',
    geographies: ['96720', 'Hawaii'],
    metricKeys: ['median_rent_burden_pct'],
  })

  it('resolution records Hawaii as a state aggregate over every Hawaii ZIP', () => {
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX)
    expect(resolved.stateAggregates).toHaveLength(1)
    expect(resolved.stateAggregates[0]?.label).toBe('Hawaii')
    expect([...(resolved.stateAggregates[0]?.zctas ?? [])].sort()).toEqual([
      '96720', '96749', '96760', '96813',
    ])
  })

  it('the card shows 96720 beside the state average — never Hawaiian Acres', async () => {
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: QUERY,
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Hawaii state average'])
    const stateAverage = answer?.places[1]
    expect(stateAverage?.memberZctas?.sort()).toEqual(['96720', '96749', '96760', '96813'])
    // Population-weighted burden over all four Hawaii rows:
    // (32*45000 + 35*20000 + 30*30000 + 45*10000) / 105000.
    const expected = (32 * 45000 + 35 * 20000 + 30 * 30000 + 45 * 10000) / 105000
    expect(stateAverage?.figures[0]?.value).toBeCloseTo(expected, 6)
    expect(answer?.stateMethod).not.toBeNull()
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Hawaii state average')
    expect(text).toContain('population-weighted averages of their ZIP areas')
    expect(text).not.toContain('Hawaiian Acres')
  })
})

describe('B6: Midwest resolves to the Census region, disclosed — never the Wyoming town', () => {
  const geoIntent = intent({
    geographies: ['Midwest'],
    metricKeys: ['median_home_value', 'median_household_income'],
  })

  it('resolution covers region states, excludes Midwest, WY, and discloses the reading', () => {
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX)
    expect([...resolved.zctas].sort()).toEqual(['50301', '60601'])
    expect(resolved.zctas.has('82643')).toBe(false)
    expect(resolved.geographyDisclosures).toHaveLength(1)
    expect(resolved.geographyDisclosures[0]).toContain('Census region of that name')
    expect(resolved.geographyDisclosures[0]).toContain('Illinois')
  })

  it('the card shows region places with the disclosure, and no same-named town', async () => {
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: 'Best value homes in the Midwest — high income, low home prices',
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Des Moines, IA', 'Chicago, IL'])
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Midwest was read as the Census region of that name')
    expect(text).not.toContain('Midwest, WY')
    expect(text).not.toContain('82643')
  })

  it('an unserved region name is disclosed as not served at that granularity', () => {
    // CHANGED (named-area cure, 2026-11-04): the specimen region
    // was "Pacific Northwest", which gained a confirmed reading in
    // the named-region gazetteer (WA + OR) and now resolves at step
    // 3b — pinned in named-area.test.tsx. "Great Plains" carries no
    // gazetteer entry and pins the protected behavior unchanged: a
    // region with no servable definition is disclosed as not served
    // at that granularity, never matched to a same-named place.
    const resolved = resolveAnswerGeographies(
      intent({ geographies: ['Great Plains'] }),
      PLACE_INDEX,
    )
    expect(resolved.unresolvedGeographies).toEqual(['Great Plains'])
    expect(resolved.geographyDisclosures[0]).toContain('does not serve at region level')
  })
})

describe('B3: research-first places count by place, not by split ZIP', () => {
  it('Corbin counts once, and its claimless split ZIP is neither listed nor counted', async () => {
    const geoIntent = intent({ mode: 'lookup', geographies: [], metricKeys: [] })
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText:
        'find the top five places that have the best schools but also the least average cost of living',
      rows: ROWS,
      resolved: resolveAnswerGeographies(geoIntent, PLACE_INDEX),
      provider: createStubProvider({
        async research() {
          return {
            prose:
              'Hilo, HI schools are rated above the state average in the cited directory. ' +
              'Corbin, KY schools are rated above the state average in the cited directory. ' +
              'Austin, TX schools are rated above the state average in the cited directory.',
            sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
          }
        },
      }),
      research: true,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.requestedCount).toBe(5)
    // Three places were named; the places are the three, in research
    // order, one representative ZIP per place.
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Corbin, KY', 'Austin, TX'])
    expect(answer?.places.map((p) => p.zcta)).toEqual(['96720', '40701', '73301'])
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('You asked for 5 places; the cited research named 3')
    expect(text).not.toContain('40771')
  })
})

describe('views consistency: the card geography lines read the resolution result', () => {
  it('a fully resolved card carries no unresolved line and no could-not-resolve text', async () => {
    const geoIntent = intent({ mode: 'lookup', geographies: ['Hilo, HI'] })
    const resolved = resolveAnswerGeographies(geoIntent, PLACE_INDEX)
    const answer = await composeAnswerForRequest({
      intent: geoIntent,
      queryText: 'What is the median rent in Hilo, HI?',
      rows: ROWS,
      resolved,
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      stack: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.unresolvedGeographies).toEqual(resolved.unresolvedGeographies)
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Hilo, HI')
    expect(text).not.toContain('could not be resolved')
    expect(text).not.toContain('No ZIP code could be resolved')
  })
})
