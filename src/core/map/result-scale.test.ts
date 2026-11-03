import { describe, expect, it } from 'vitest'

import type { AnswerPlace, ComposedAnswer } from '../ai/answer'
import {
  answerPlaceAnchorId,
  colorForValue,
  drivingMetricKey,
  eligibleMetricKeys,
  emittedFigureValues,
  formatAnswerFigure,
  legendModel,
  nationalCircleRadius,
  orderedResultPlaces,
  overflowPlaceNames,
  overflowPlaceSummary,
  qualifyingPlacesMapRelevant,
  resultMapMode,
  resultMapPlaces,
  resultMapRelevant,
  screeningCoverageLine,
  terminalChartKinds,
  OVERFLOW_NAME_LIMIT,
} from './result-scale'

/**
 * Hermetic pins for the result-map model. The figures-by-reference
 * assertion is mechanical (spec section 6.7): every number the map
 * layer can emit must exist, exactly, among the verified answer's
 * figures — a recompute path added later fails here.
 */

function place(zcta: string, name: string, figures: [string, number][], memberZctas?: string[]): AnswerPlace {
  return {
    zcta,
    name,
    figures: figures.map(([key, value]) => ({ key, value })),
    claims: [],
    ...(memberZctas ? { memberZctas } : {}),
  }
}

function answer(partial: Partial<ComposedAnswer>): ComposedAnswer {
  return {
    status: 'verified',
    stage: 'verify',
    criteria: [{ metricKey: 'median_gross_rent', bound: 'atMost', value: 2000, intentOp: 'lt' }],
    droppedCriteria: [],
    unresolvedGeographies: [],
    geographyDisclosures: [],
    screenedCount: 3,
    places: [],
    generalClaims: [],
    sources: [],
    summary: '',
    droppedClaims: [],
    failures: [],
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: 10,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'place',
    stateMethod: null,
    unsupportedGeography: null,
    requestedCount: null,
    countyMethod: null,
    notMeasurableCounties: [],
    ...partial,
  }
}

const SEATTLE = [
  place('98101', 'Seattle, WA', [['median_gross_rent', 2340], ['median_home_value', 820000]]),
  place('98103', 'Seattle, WA', [['median_gross_rent', 1895], ['median_home_value', 765000]]),
  place('98115', 'Seattle, WA', [['median_gross_rent', 890], ['median_home_value', 640000]]),
]

describe('figures by reference — mechanical', () => {
  it('every emitted number exists exactly on the verified answer places', () => {
    const a = answer({ places: SEATTLE })
    const cardValues = new Set(a.places.flatMap((p) => p.figures.map((f) => f.value)))
    for (const metric of ['median_gross_rent', 'median_home_value']) {
      const emitted = emittedFigureValues(a, metric)
      expect(emitted.length).toBeGreaterThan(0)
      for (const value of emitted) expect(cardValues.has(value)).toBe(true)
    }
  })

  it('formatting matches the card formatter for the same figure', () => {
    const figure = { key: 'median_gross_rent', value: 2340 }
    // The card renders median gross rent as $2,340/mo (registry unit + sweep precision).
    expect(formatAnswerFigure(figure)).toBe('$2,340/mo')
  })

  it('a place with no figure for the selected metric resolves to the no-data treatment, not an invented value', () => {
    const places = resultMapPlaces(
      [place('98101', 'Seattle, WA', [['median_gross_rent', 1000]]), place('98102', 'Seattle, WA', [['households', 500]])],
      'median_gross_rent',
    )
    expect(places[1]!.figure).toBeNull()
    expect(places[1]!.formatted).toBeNull()
  })
})

describe('metric eligibility and driving metric', () => {
  it('offers the intersection of figure keys with the driving metric first', () => {
    const a = answer({ places: SEATTLE })
    expect(drivingMetricKey(a)).toBe('median_gross_rent')
    expect(eligibleMetricKeys(SEATTLE, drivingMetricKey(a))).toEqual(['median_gross_rent', 'median_home_value'])
  })

  it('switching the metric only re-reads figures — the place set and order do not change', () => {
    const a = answer({ places: SEATTLE })
    const byRent = resultMapPlaces(orderedResultPlaces(a), 'median_gross_rent').map((p) => p.key)
    const byValue = resultMapPlaces(orderedResultPlaces(a), 'median_home_value').map((p) => p.key)
    expect(byValue).toEqual(byRent)
  })
})

describe('legend model — ends carry the figures', () => {
  it('labels the ends with the max/min places figures verbatim', () => {
    const legend = legendModel(SEATTLE, 'median_gross_rent')
    expect(legend.single).toBe(false)
    expect(legend.highest?.value).toBe(2340)
    expect(legend.highest?.text).toBe('Highest median gross rent — $2,340/mo')
    expect(legend.lowest?.value).toBe(890)
    expect(legend.lowest?.text).toBe('Lowest median gross rent — $890/mo')
  })

  it('a single place gets no gradient claim, just the words', () => {
    const legend = legendModel([SEATTLE[0]!], 'median_gross_rent')
    expect(legend.single).toBe(true)
    expect(legend.singleText).toBe('One place in this answer.')
    expect(legend.highest).toBeNull()
  })

  it('two places sharing one value: no gradient, and the wording counts both places (closing A3)', () => {
    // Tucson, AZ 85701 + Brownsville, TX 78520, both $300,000 home
    // value — the A3 shape. No range exists, so no gradient is
    // claimed, but the text must not say "One place" for two places.
    const places = [
      place('85701', 'Tucson, AZ', [['median_home_value', 300000]]),
      place('78520', 'Brownsville, TX', [['median_home_value', 300000]]),
    ]
    const legend = legendModel(places, 'median_home_value')
    expect(legend.single).toBe(true)
    expect(legend.highest).toBeNull()
    expect(legend.lowest).toBeNull()
    expect(legend.singleText).not.toContain('One place')
    expect(legend.singleText).toContain('2 places')
    expect(legend.singleText).toContain('$300,000')
  })
})

describe('color scale — continuous, darker = higher', () => {
  it('the maximum is darker than the minimum and the ramp is monotonic in between', () => {
    const brightness = (css: string) => {
      const parts = css.match(/\d+/g)!.map(Number)
      return parts[0]! + parts[1]! + parts[2]!
    }
    const low = colorForValue(890, 890, 2340)
    const mid = colorForValue(1600, 890, 2340)
    const high = colorForValue(2340, 890, 2340)
    expect(brightness(high)).toBeLessThan(brightness(mid))
    expect(brightness(mid)).toBeLessThan(brightness(low))
    expect(colorForValue(100, 100, 100)).toBe(colorForValue(100, 100, 100))
  })
})

describe('mode detection — from the actual places, not the question scope', () => {
  it('B2 shape: one place at national question level renders scoped, not national', () => {
    // Demo question 1's answer: exactly one locality, Hilo, HI 96720,
    // under a national-level question (closing battery cluster B2 —
    // result_map_mode_keyed_to_question_scope).
    const places = [place('96720', 'Hilo, HI', [['median_gross_rent', 1600]])]
    const points = new Map([['96720', { lon: -155.09, lat: 19.64 }]])
    expect(resultMapMode(answer({ geographyLevel: 'national', places }), points)).toBe('choropleth')
    expect(resultMapMode(answer({ geographyLevel: 'national', places }))).toBe('choropleth')
  })

  it('B3 shape: dispersed HI/KY/TX places at national level stay national', () => {
    const places = [
      place('96720', 'Hilo, HI', [['median_gross_rent', 1600]]),
      place('40701', 'Corbin, KY', [['median_gross_rent', 650]]),
      place('78520', 'Brownsville, TX', [['median_gross_rent', 950]]),
    ]
    const points = new Map([
      ['96720', { lon: -155.09, lat: 19.64 }],
      ['40701', { lon: -84.09, lat: 36.95 }],
      ['78520', { lon: -97.5, lat: 25.9 }],
    ])
    expect(resultMapMode(answer({ geographyLevel: 'national', places }), points)).toBe('national')
    // Without centroids the 3-state national-level set still resolves
    // national via the level hint (the only unmeasurable case).
    expect(resultMapMode(answer({ geographyLevel: 'national', places }))).toBe('national')
  })

  it('two nearby places at national question level render scoped (same county-scale cluster)', () => {
    const places = [
      place('96720', 'Hilo, HI', [['median_gross_rent', 1600]]),
      place('96749', 'Keaau, HI', [['median_gross_rent', 1450]]),
    ]
    const points = new Map([
      ['96720', { lon: -155.09, lat: 19.64 }],
      ['96749', { lon: -155.04, lat: 19.62 }],
    ])
    expect(resultMapMode(answer({ geographyLevel: 'national', places }), points)).toBe('choropleth')
  })

  it('a local multi-place set at national level renders scoped — the level does not override the places', () => {
    // This replaces the pre-P6b pin that asserted the defective
    // behaviour itself (a Seattle-only set rendering national purely
    // because geographyLevel said so).
    const points = new Map([
      ['98101', { lon: -122.33, lat: 47.61 }],
      ['98103', { lon: -122.34, lat: 47.68 }],
      ['98115', { lon: -122.31, lat: 47.68 }],
    ])
    expect(resultMapMode(answer({ geographyLevel: 'national', places: SEATTLE }), points)).toBe('choropleth')
    expect(resultMapMode(answer({ geographyLevel: 'national', places: SEATTLE }))).toBe('choropleth')
  })

  it('a coast-to-coast place set renders centroid mode by span', () => {
    const places = [
      place('98101', 'Seattle, WA', [['median_gross_rent', 2000]]),
      place('10001', 'New York, NY', [['median_gross_rent', 2100]]),
    ]
    const points = new Map([
      ['98101', { lon: -122.3, lat: 47.6 }],
      ['10001', { lon: -73.9, lat: 40.7 }],
    ])
    expect(resultMapMode(answer({ geographyLevel: 'place', places }), points)).toBe('national')
  })

  it('a two-state metro cluster stays a choropleth (Kansas City shape)', () => {
    const places = [
      place('64106', 'Kansas City, MO', [['median_gross_rent', 1100]]),
      place('66101', 'Kansas City, KS', [['median_gross_rent', 950]]),
    ]
    const points = new Map([
      ['64106', { lon: -94.58, lat: 39.1 }],
      ['66101', { lon: -94.62, lat: 39.11 }],
    ])
    expect(resultMapMode(answer({ geographyLevel: 'place', places }), points)).toBe('choropleth')
  })

  it('four or more states render centroid mode even at place level', () => {
    const places = ['Seattle, WA', 'Portland, OR', 'Boise, ID', 'Reno, NV'].map((name, i) =>
      place(String(97000 + i), name, [['median_gross_rent', 1000 + i]]),
    )
    expect(resultMapMode(answer({ geographyLevel: 'place', places }))).toBe('national')
  })

  it('national circles grow with value: larger and ordered by the square root band', () => {
    expect(nationalCircleRadius(2340, 890, 2340)).toBeGreaterThan(nationalCircleRadius(890, 890, 2340))
    expect(nationalCircleRadius(890, 890, 2340)).toBe(5)
    expect(nationalCircleRadius(2340, 890, 2340)).toBe(22)
  })
})

describe('county guard — a county figure is never painted onto member ZCTAs', () => {
  const county = place('county:06081', 'San Mateo County, CA', [['median_gross_rent', 2800]], ['94002', '94010', '94401'])
  const a = answer({ geographyLevel: 'county', places: [county], screenedCount: 3 })

  it('county answers resolve to county mode', () => {
    expect(resultMapMode(a)).toBe('county')
  })

  it('a single county place still resolves to county mode — the one merged outline, as P2c left it', () => {
    // County is checked before the single-place scoped rule, so the
    // P6b actual-places cure cannot demote a county answer into a
    // choropleth of its synthetic key.
    expect(resultMapMode(answer({ geographyLevel: 'county', places: [county] }))).toBe('county')
    expect(resultMapMode(answer({ geographyLevel: 'national', places: [county] }))).toBe('county')
  })

  it('the colored set contains exactly the county key — no member ZCTA is assigned the county figure', () => {
    const colored = resultMapPlaces(a.places, 'median_gross_rent')
    expect(colored.map((p) => p.key)).toEqual(['county:06081'])
    for (const member of ['94002', '94010', '94401']) {
      expect(colored.some((p) => p.key === member)).toBe(false)
    }
    expect(colored[0]!.isCounty).toBe(true)
    expect(colored[0]!.memberZctas).toEqual(['94002', '94010', '94401'])
    // The only emitted figure is the county's own, from its own figure list
    // (single place, so the legend adds no end values).
    expect(emittedFigureValues(a, 'median_gross_rent')).toEqual([2800])
  })
})

describe('mixed aggregate + plain place — the model keeps both, each with its own figure (P2e)', () => {
  // The C6 shape (closing battery cluster C, on be13e7e): the Hawaii
  // state average as an aggregate place over 6 member ZCTAs, beside
  // Hilo (96720) as a plain place — 96720 is BOTH a member of the
  // aggregate and a card place in its own right.
  const aggregate = place(
    'county:HI:Hawaii',
    'Hawaii state average',
    [['median_rent_burden_pct', 32.31]],
    ['96720', '96740', '96749', '96760', '96761', '96778'],
  )
  const hilo = place('96720', 'Hilo, HI', [['median_rent_burden_pct', 32]])
  const a = answer({ geographyLevel: 'state', places: [aggregate, hilo], screenedCount: 2 })

  it('a mixed answer still resolves to county mode (the aggregate rule fires first)', () => {
    expect(resultMapMode(a)).toBe('county')
  })

  it('the colored set holds both places: the aggregate AND Hilo, Hilo with its own 32, not the average 32.31', () => {
    const colored = resultMapPlaces(a.places, 'median_rent_burden_pct')
    expect(colored.map((p) => p.key)).toEqual(['county:HI:Hawaii', '96720'])
    expect(colored[0]!.isCounty).toBe(true)
    expect(colored[0]!.figure?.value).toBe(32.31)
    expect(colored[1]!.isCounty).toBe(false)
    expect(colored[1]!.figure?.value).toBe(32)
    // Figures by reference, both of them: the map may emit exactly
    // the two card figures and nothing else.
    expect(new Set(emittedFigureValues(a, 'median_rent_burden_pct'))).toEqual(new Set([32.31, 32]))
  })
})

describe('screening coverage line (P6 step 5)', () => {
  it('is silent when the screen, the answer, and the map all cover the same places', () => {
    const a = answer({ places: SEATTLE, screenedCount: 3 })
    expect(screeningCoverageLine(a, 3)).toBeNull()
  })

  it('states what the screen covered vs what the map shows when they differ', () => {
    const a = answer({ places: SEATTLE, screenedCount: 412 })
    const line = screeningCoverageLine(a, 3)
    expect(line).toContain('412')
    expect(line).toContain('shows 3')
  })

  it('names places beyond the cap as text, in card order', () => {
    const many = Array.from({ length: 27 }, (_, i) =>
      place(String(98101 + i), `Place ${i}, WA`, [['median_gross_rent', 1000 + i]]),
    )
    const a = answer({ places: many, screenedCount: 27 })
    expect(overflowPlaceNames(a)).toHaveLength(2)
    expect(screeningCoverageLine(a, 25)).toContain('shows 25')
  })

  it('names a multi-ZIP place once in the overflow roll', () => {
    const shown = Array.from({ length: 25 }, (_, i) =>
      place(String(98101 + i), `Place ${i}, WA`, [['median_gross_rent', 1000 + i]]),
    )
    const overflow = [
      place('81001', 'Pueblo, CO', [['median_gross_rent', 1050]]),
      place('81003', 'Pueblo, CO', [['median_gross_rent', 1100]]),
      place('81008', 'Pueblo, CO', [['median_gross_rent', 1200]]),
      place('80201', 'Denver, CO', [['median_gross_rent', 1800]]),
    ]
    const a = answer({ places: [...shown, ...overflow], screenedCount: 29 })
    expect(overflowPlaceNames(a)).toEqual(['Pueblo, CO', 'Denver, CO'])
  })

  it('caps the roll at the name limit and counts the rest', () => {
    const many = Array.from({ length: 25 + OVERFLOW_NAME_LIMIT + 10 }, (_, i) =>
      place(String(10000 + i), `Place ${i}, WA`, [['median_gross_rent', 1000 + i]]),
    )
    const a = answer({ places: many, screenedCount: many.length })
    const summary = overflowPlaceSummary(a)
    expect(summary.names).toHaveLength(OVERFLOW_NAME_LIMIT)
    expect(summary.furtherCount).toBe(10)
  })
})

describe('chart relevance (owner rules, 2026-11-03)', () => {
  it('renders for a screen-composed geographic answer', () => {
    expect(resultMapRelevant(answer({ places: SEATTLE }))).toBe(true)
  })

  it('renders for a county answer', () => {
    const counties = [
      place('county:CO:Pueblo', 'Pueblo County, CO', [['median_gross_rent', 1050]], ['81001', '81003']),
      place('county:CO:El Paso', 'El Paso County, CO', [['median_gross_rent', 1350]], ['80901']),
    ]
    expect(resultMapRelevant(answer({ places: counties, geographyLevel: 'county' }))).toBe(true)
  })

  it('does not render for a research-first candidate answer', () => {
    const a = answer({ places: SEATTLE, researchNamedPlaces: ['Seattle, WA'] })
    expect(resultMapRelevant(a)).toBe(false)
  })

  it('does not render for a single place or a non-verified answer', () => {
    expect(resultMapRelevant(answer({ places: [SEATTLE[0]!] }))).toBe(false)
    expect(resultMapRelevant(answer({ places: SEATTLE, status: 'empty' }))).toBe(false)
  })
})

describe('qualifying-places map relevance (Lane completion K7)', () => {
  it('renders for a research-first candidate answer — the class the choropleth excludes', () => {
    const a = answer({ places: SEATTLE, researchNamedPlaces: ['Seattle, WA'] })
    expect(qualifyingPlacesMapRelevant(a)).toBe(true)
    // The two predicates are mutually exclusive: one map per card.
    expect(resultMapRelevant(a)).toBe(false)
  })

  it('does not render for a screen-composed answer (the choropleth path is unchanged)', () => {
    const a = answer({ places: SEATTLE })
    expect(qualifyingPlacesMapRelevant(a)).toBe(false)
    expect(resultMapRelevant(a)).toBe(true)
  })

  it('needs two pointable places: county aggregates and singletons do not qualify', () => {
    const counties = [
      place('county:TX:Travis', 'Travis County, TX', [['median_gross_rent', 1500]], ['78701']),
      place('county:TX:Hays', 'Hays County, TX', [['median_gross_rent', 1300]], ['78666']),
    ]
    expect(
      qualifyingPlacesMapRelevant(
        answer({ places: counties, researchNamedPlaces: ['Austin, TX'] }),
      ),
    ).toBe(false)
    expect(
      qualifyingPlacesMapRelevant(
        answer({ places: [SEATTLE[0]!], researchNamedPlaces: ['Seattle, WA'] }),
      ),
    ).toBe(false)
    expect(
      qualifyingPlacesMapRelevant(
        answer({ places: SEATTLE, researchNamedPlaces: ['Seattle, WA'], status: 'empty' }),
      ),
    ).toBe(false)
  })

  it('the spoken chart derivation names the points map with its own sentence', () => {
    const kinds = terminalChartKinds(
      answer({ places: SEATTLE, researchNamedPlaces: ['Seattle, WA'] }),
    )
    expect(kinds).toHaveLength(1)
    expect(kinds[0]!.sentence).toBe('The map shows the places this answer names.')
    // And the choropleth path keeps its metric-subject form.
    const screenKinds = terminalChartKinds(answer({ places: SEATTLE }))
    expect(screenKinds).toHaveLength(1)
    expect(screenKinds[0]!.sentence).toBeUndefined()
    expect(screenKinds[0]!.subject).toBe('median gross rent')
  })

  it('the anchor id is the place\u2019s card-entry id', () => {
    expect(answerPlaceAnchorId('78701')).toBe('answer-place-78701')
  })
})
