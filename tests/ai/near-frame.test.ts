import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'
import {
  buildNearFrameContext,
  detectNearFrame,
  haversineMiles,
  isFrameSegmentText,
  nearCandidatePrefixes,
  nearCandidates,
  rerouteSimilarityToNearFrame,
} from '../../src/core/ai/near-frame'

/**
 * The near frame (owner live specimen, 2026-11-03, production
 * 9a75c2f): "where near philadelphia has good schools and lower
 * cost of living, within 20 miles (as compared to philadelphia
 * itself)" answered with the reference alone, certified against
 * itself. These pins hold the frame's mechanics: detection stays
 * narrow enough that the shipped shapes never see it, the
 * candidate set is drawn from the product's own centroid
 * geography with the anchor excluded, and the reference baseline
 * is the population-weighted aggregate of ALL of the anchor's ZIP
 * areas — never one resolved ZIP wearing the place's name.
 */

const SPECIMEN =
  'where near philadelphia has good schools and lower cost of living, within 20 miles (as compared to philadelphia itself).'

const PLACES: PlaceSuggestion[] = [
  { displayName: 'Philadelphia', censusName: 'Philadelphia city', state: 'PA', isCity: true, zips: ['19102', '19103', '19104'] },
  { displayName: 'Bala Cynwyd', censusName: 'Bala Cynwyd CDP', state: 'PA', isCity: true, zips: ['19004'] },
  { displayName: 'Upper Darby', censusName: 'Upper Darby township', state: 'PA', isCity: true, zips: ['19082'] },
  { displayName: 'King of Prussia', censusName: 'King of Prussia CDP', state: 'PA', isCity: true, zips: ['19406'] },
  { displayName: 'Allentown', censusName: 'Allentown city', state: 'PA', isCity: true, zips: ['18101'] },
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

/** Centroids around Philadelphia (lon/lat), spaced like the real geography. */
const CENTROIDS: ZctaPoint[] = [
  { zcta: '19102', lon: -75.162, lat: 39.95 },
  { zcta: '19103', lon: -75.172, lat: 39.956 },
  { zcta: '19104', lon: -75.21, lat: 39.96 },
  { zcta: '19004', lon: -75.235, lat: 39.998 },
  { zcta: '19082', lon: -75.262, lat: 39.965 },
  { zcta: '19406', lon: -75.385, lat: 40.092 },
  { zcta: '18101', lon: -75.49, lat: 40.602 },
]

const ROWS: AreaRow[] = [
  { zcta: '19102', name: 'ZCTA5 19102', metrics: { median_gross_rent: 2249, population: 10000 }, moes: { median_gross_rent: 138 } },
  { zcta: '19103', name: 'ZCTA5 19103', metrics: { median_gross_rent: 1900, population: 20000 }, moes: { median_gross_rent: 90 } },
  { zcta: '19104', name: 'ZCTA5 19104', metrics: { median_gross_rent: 1500, population: 30000 }, moes: { median_gross_rent: 60 } },
  { zcta: '19004', name: 'ZCTA5 19004', metrics: { median_gross_rent: 1200, population: 8000 }, moes: { median_gross_rent: 75 } },
  { zcta: '19082', name: 'ZCTA5 19082', metrics: { median_gross_rent: 1350, population: 9000 }, moes: { median_gross_rent: 80 } },
  { zcta: '19406', name: 'ZCTA5 19406', metrics: { median_gross_rent: 2600, population: 7000 }, moes: { median_gross_rent: 110 } },
  { zcta: '18101', name: 'ZCTA5 18101', metrics: { median_gross_rent: 900, population: 6000 }, moes: { median_gross_rent: 50 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

describe('detectNearFrame', () => {
  it('detects the specimen: stated radius, cost comparative, one place anchor', () => {
    const spec = detectNearFrame(SPECIMEN, intent({ geographies: ['Philadelphia, PA'] }))
    expect(spec).not.toBeNull()
    expect(spec?.radiusMiles).toBe(20)
    expect(spec?.radiusStated).toBe(true)
    expect(spec?.relativeCost).toBe(true)
    expect(spec?.anchorGeography).toBe('Philadelphia, PA')
  })

  it('a near phrase with no stated radius reads at the default radius', () => {
    const spec = detectNearFrame(
      'What suburbs of Philadelphia have good schools?',
      intent({ geographies: ['Philadelphia, PA'] }),
    )
    expect(spec?.radiusMiles).toBe(25)
    expect(spec?.radiusStated).toBe(false)
    expect(spec?.relativeCost).toBe(false)
  })

  it('a plain lookup of the place is not a frame', () => {
    expect(
      detectNearFrame('What is the median rent in Philadelphia, PA?', intent({ geographies: ['Philadelphia, PA'] })),
    ).toBeNull()
  })

  it('a two-place comparison is not a frame', () => {
    expect(
      detectNearFrame(
        'Compare places near Philadelphia, PA and Camden, NJ',
        intent({ geographies: ['Philadelphia, PA', 'Camden, NJ'] }),
      ),
    ).toBeNull()
  })

  it('state-bounded shapes are not frames (the Colorado specimen class)', () => {
    expect(
      detectNearFrame(
        'what city in Colorado has the best nature and the lowest cost of living?',
        intent({ geographies: ['Colorado'] }),
      ),
    ).toBeNull()
    expect(
      detectNearFrame('where near Pennsylvania has lower rent?', intent({ geographies: ['Pennsylvania'] })),
    ).toBeNull()
  })

  it('a ZIP or county geography is not a frame anchor', () => {
    expect(detectNearFrame('what is near 19102?', intent({ geographies: ['19102'] }))).toBeNull()
    expect(
      detectNearFrame(
        'where near Philadelphia County has good schools?',
        intent({ geographies: ['Philadelphia County, PA'] }),
      ),
    ).toBeNull()
  })
})

describe('isFrameSegmentText', () => {
  const frame = { anchorName: 'Philadelphia', radiusMiles: 20 }
  it('the specimen residue segment is only the frame phrase', () => {
    expect(isFrameSegmentText('within 20 miles (as compared to philadelphia itself)', frame)).toBe(true)
  })
  it('a segment carrying a real criterion beside the frame is not the frame', () => {
    expect(isFrameSegmentText('within 20 miles of good schools', frame)).toBe(false)
    expect(isFrameSegmentText('good schools', frame)).toBe(false)
  })
})

describe('haversineMiles', () => {
  it('Philadelphia to New York City is about 80 miles', () => {
    const d = haversineMiles({ lon: -75.16, lat: 39.95 }, { lon: -74.0, lat: 40.71 })
    expect(d).toBeGreaterThan(75)
    expect(d).toBeLessThan(85)
  })
})

describe('nearCandidates + buildNearFrameContext', () => {
  const spec = detectNearFrame(SPECIMEN, intent({ geographies: ['Philadelphia, PA'] }))!

  it('draws the places within the radius and excludes the anchor and the far place', () => {
    const byZip = new Map(CENTROIDS.map((p) => [p.zcta, p]))
    const anchor = INDEX.search('Philadelphia, PA', 8)[0]!
    const candidates = nearCandidates(INDEX, byZip, anchor, 20)
    expect(candidates.map((c) => c.place.displayName)).toEqual([
      'Upper Darby',
      'Bala Cynwyd',
      'King of Prussia',
    ])
    expect(candidates.every((c) => c.distanceMiles <= 20)).toBe(true)
  })

  it('the baseline is the weighted aggregate of ALL the anchor ZIP areas, not the first ZIP', () => {
    const context = buildNearFrameContext({
      spec,
      placeIndex: INDEX,
      centroids: CENTROIDS,
      rows: ROWS,
      figureKeys: ['median_gross_rent'],
      baselineKey: 'median_gross_rent',
      costReading: true,
    })
    expect(context).not.toBeNull()
    expect(context?.anchorLabel).toBe('Philadelphia, PA')
    expect(context?.anchorZipCount).toBe(3)
    expect([...(context?.candidateZctas ?? [])].sort()).toEqual(['19004', '19082', '19406'])
    expect(context?.candidatePrefixes).toEqual(['19'])
    // (2249*10000 + 1900*20000 + 1500*30000) / 60000 = 1758.17 —
    // not 2249, the first resolved ZIP's figure.
    expect(context?.baseline?.value).toBeCloseTo(1758.17, 1)
    expect(context?.baseline?.value).not.toBe(2249)
    expect(context?.baseline?.margin).not.toBeNull()
    expect(context?.relativeCost).toBe(true)
  })

  it('the relative bound disarms when the question carries no cost reading', () => {
    const context = buildNearFrameContext({
      spec,
      placeIndex: INDEX,
      centroids: CENTROIDS,
      rows: ROWS,
      figureKeys: ['median_gross_rent'],
      baselineKey: 'median_gross_rent',
      costReading: false,
    })
    expect(context?.relativeCost).toBe(false)
    expect(context?.baseline?.value).toBeCloseTo(1758.17, 1)
  })

  it('no candidates within the radius: the frame does not engage', () => {
    const tiny = detectNearFrame(
      'where near philadelphia has good schools, within 1 miles',
      intent({ geographies: ['Philadelphia, PA'] }),
    )!
    expect(
      buildNearFrameContext({
        spec: tiny,
        placeIndex: INDEX,
        centroids: CENTROIDS,
        rows: ROWS,
        figureKeys: ['median_gross_rent'],
        baselineKey: 'median_gross_rent',
        costReading: true,
      }),
    ).toBeNull()
    expect(nearCandidatePrefixes({ spec: tiny, placeIndex: INDEX, centroids: CENTROIDS })).toBeNull()
  })

  it('an anchor the index does not know: the frame does not engage', () => {
    const unknown = detectNearFrame(
      'where near zzyzx has good schools, within 20 miles',
      intent({ geographies: ['Zzyzx, CA'] }),
    )!
    expect(
      buildNearFrameContext({
        spec: unknown,
        placeIndex: INDEX,
        centroids: CENTROIDS,
        rows: ROWS,
        figureKeys: ['median_gross_rent'],
        baselineKey: 'median_gross_rent',
        costReading: true,
      }),
    ).toBeNull()
  })

  it('candidate prefixes cover the candidate ZIPs for the App scoped load', () => {
    expect(nearCandidatePrefixes({ spec, placeIndex: INDEX, centroids: CENTROIDS })).toEqual(['19'])
  })
})

describe('rerouteSimilarityToNearFrame (round 2: the routing discrimination)', () => {
  const similarity = (partial: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
    mode: 'similarity',
    geographies: ['Philadelphia, PA'],
    metricKeys: ['median_gross_rent', 'median_home_value'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  })

  it('re-routes the specimen verbatim: the label loses to the signal set', () => {
    const rerouted = rerouteSimilarityToNearFrame(similarity(), SPECIMEN, [])
    expect(rerouted).not.toBeNull()
    expect(rerouted?.mode).toBe('lookup')
    // The parse's own measures ride verbatim; geography untouched.
    expect(rerouted?.metricKeys).toEqual(['median_gross_rent', 'median_home_value'])
    expect(rerouted?.geographies).toEqual(['Philadelphia, PA'])
  })

  it('re-routes the capitalized form', () => {
    const rerouted = rerouteSimilarityToNearFrame(
      similarity(),
      'Where near Philadelphia has good schools and lower cost of living, within 20 miles (as compared to Philadelphia itself)?',
      [],
    )
    expect(rerouted?.mode).toBe('lookup')
  })

  it('re-routes without the parenthetical', () => {
    const rerouted = rerouteSimilarityToNearFrame(
      similarity(),
      'where near philadelphia has good schools and lower cost of living, within 20 miles',
      [],
    )
    expect(rerouted?.mode).toBe('lookup')
  })

  it('re-routes the "within 20 miles of Philadelphia" ordering', () => {
    const rerouted = rerouteSimilarityToNearFrame(
      similarity(),
      'What places within 20 miles of Philadelphia have good schools and lower rent?',
      [],
    )
    expect(rerouted?.mode).toBe('lookup')
  })

  it('completes the measures from the caller when the parse carries none', () => {
    const rerouted = rerouteSimilarityToNearFrame(
      similarity({ metricKeys: [] }),
      'What suburbs of Philadelphia have good schools?',
      ['median_gross_rent'],
    )
    expect(rerouted?.mode).toBe('lookup')
    expect(rerouted?.metricKeys).toEqual(['median_gross_rent'])
    // No measures anywhere: the lookup cannot run, so nothing is re-routed.
    expect(
      rerouteSimilarityToNearFrame(
        similarity({ metricKeys: [] }),
        'What suburbs of Philadelphia have good schools?',
        [],
      ),
    ).toBeNull()
  })

  it('genuine similarity questions keep their lane', () => {
    expect(
      rerouteSimilarityToNearFrame(similarity(), 'places similar to Philadelphia', []),
    ).toBeNull()
    expect(
      rerouteSimilarityToNearFrame(similarity(), 'towns like Philadelphia for retirees', []),
    ).toBeNull()
  })

  it('a likeness predicate refuses the re-route even with the frame envelope present', () => {
    expect(
      rerouteSimilarityToNearFrame(
        similarity(),
        'places similar to Philadelphia within 20 miles',
        [],
      ),
    ).toBeNull()
    expect(
      rerouteSimilarityToNearFrame(
        similarity(),
        'towns like Philadelphia within 20 miles of the city center',
        [],
      ),
    ).toBeNull()
  })

  it('only the similarity label is re-read: other modes pass through untouched', () => {
    expect(
      rerouteSimilarityToNearFrame(intent({ geographies: ['Philadelphia, PA'] }), SPECIMEN, []),
    ).toBeNull()
    expect(
      rerouteSimilarityToNearFrame(
        similarity({ mode: 'sweep_filter' }),
        SPECIMEN,
        [],
      ),
    ).toBeNull()
  })

  it('a two-place similarity parse is not a frame', () => {
    expect(
      rerouteSimilarityToNearFrame(
        similarity({ geographies: ['Philadelphia, PA', 'Camden, NJ'] }),
        'towns near Philadelphia and Camden, within 20 miles',
        [],
      ),
    ).toBeNull()
  })
})
