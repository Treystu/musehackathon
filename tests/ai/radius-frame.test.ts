import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'
import {
  buildRadiusFrameContext,
  detectRadiusFrame,
  type RadiusFrameSpec,
} from '../../src/core/ai/near-frame'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * The Florida radius specimen (owner live specimen, 2026-11-04,
 * production 94f796e): "What's the cheapest place to live in
 * Florida within 100 miles of Miami?" The shipped answer screened
 * all 1,013 Florida places by rent, treated the radius as a
 * research criterion assessed per place from web snippets, led
 * with places hundreds of miles outside the radius (Putnam County
 * $519 at ~282 mi), rendered raw search-result titles as finding
 * prose, and never named the cheapest place inside the radius.
 * These pins hold the cured shape:
 *   - the radius is detected as geography when a stated radius is
 *     anchored at a named place beside a broader geography, in the
 *     phrase forms the parse can reach;
 *   - the candidate set is drawn deterministically from the
 *     product's own centroid geography — anchor included, edge
 *     pair just inside / just outside, co-named state applied as
 *     an intersection;
 *   - the pipeline traversal leads with the cheapest IN-RADIUS
 *     place, excludes the cheapest-overall place outside the
 *     radius entirely, runs NO research for the pure radius class,
 *     and accounts the radius from the frame in the evidence;
 *   - a genuine second criterion (schools) still researches —
 *     over the in-radius candidates only — while the radius
 *     itself never reaches the research path.
 */

const SPECIMEN = "What's the cheapest place to live in Florida within 100 miles of Miami?"

function intent(geographies: string[]): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies,
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
  }
}

describe('detectRadiusFrame', () => {
  it('detects the specimen: state sweep beside the anchor', () => {
    const spec = detectRadiusFrame(SPECIMEN, intent(['FL', 'Miami, FL']))
    expect(spec?.radiusMiles).toBe(100)
    expect(spec?.anchorGeography).toBe('Miami, FL')
    expect(spec?.phraseText).toBe('within 100 miles of Miami')
  })

  it('detects the comma variant', () => {
    const spec = detectRadiusFrame(
      'What is the cheapest place to live in Florida, within 100 miles of Miami?',
      intent(['FL', 'Miami, FL']),
    )
    expect(spec?.radiusMiles).toBe(100)
  })

  it('detects the mi abbreviation and the radius forms', () => {
    expect(
      detectRadiusFrame(
        "What's the cheapest place to live in Florida within 50 mi of Orlando?",
        intent(['FL', 'Orlando, FL']),
      )?.radiusMiles,
    ).toBe(50)
    expect(
      detectRadiusFrame(
        "What's the cheapest place to live in Texas no more than 30 miles from Austin?",
        intent(['TX', 'Austin, TX']),
      )?.radiusMiles,
    ).toBe(30)
    expect(
      detectRadiusFrame(
        "What's the cheapest place to live in Colorado within a 25-mile radius of Denver?",
        intent(['CO', 'Denver, CO']),
      )?.radiusMiles,
    ).toBe(25)
    expect(
      detectRadiusFrame(
        "What's the cheapest place to live in Florida inside a 40 mile radius of Tampa?",
        intent(['FL', 'Tampa, FL']),
      )?.radiusMiles,
    ).toBe(40)
  })

  it('refuses the near frame class: a single geography is the reference shape', () => {
    expect(detectRadiusFrame(SPECIMEN, intent(['Miami, FL']))).toBeNull()
  })

  it('refuses shapes with no stated radius, no anchor, or likeness', () => {
    expect(
      detectRadiusFrame("What's the cheapest place to live in Florida?", intent(['FL', 'Miami, FL'])),
    ).toBeNull()
    expect(
      detectRadiusFrame(SPECIMEN, intent(['FL', 'Orlando, FL'])),
    ).toBeNull()
    expect(
      detectRadiusFrame(
        'What places in Florida are like Miami?',
        intent(['FL', 'Miami, FL']),
      ),
    ).toBeNull()
    expect(detectRadiusFrame(SPECIMEN, intent(['FL']))).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Fabricated Florida                                                  */
/* ------------------------------------------------------------------ */

const PLACES: PlaceSuggestion[] = [
  { displayName: 'Miami', censusName: 'Miami city', state: 'FL', isCity: true, zips: ['33101', '33132'] },
  { displayName: 'Hialeah', censusName: 'Hialeah city', state: 'FL', isCity: true, zips: ['33010'] },
  { displayName: 'Homestead', censusName: 'Homestead city', state: 'FL', isCity: true, zips: ['33030'] },
  { displayName: 'Edge In', censusName: 'Edge In city', state: 'FL', isCity: true, zips: ['33999'] },
  { displayName: 'Edge Out', censusName: 'Edge Out city', state: 'FL', isCity: true, zips: ['33998'] },
  { displayName: 'Key West', censusName: 'Key West city', state: 'FL', isCity: true, zips: ['33040'] },
  { displayName: 'Far North', censusName: 'Far North city', state: 'FL', isCity: true, zips: ['32666'] },
  // Geographically inside the radius, but its index record belongs
  // to another state: the co-named state intersection excludes it.
  { displayName: 'Border Town', censusName: 'Border Town city', state: 'GA', isCity: true, zips: ['33099'] },
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

// Anchor at Miami (25.77, -80.19). A degree of latitude is ~69
// miles: Edge In at +1.43 degrees is ~99 miles (just inside the
// stated 100), Edge Out at +1.47 degrees is ~102 miles (just
// outside). Key West is ~120 miles; Far North ~270.
const CENTROIDS: ZctaPoint[] = [
  { zcta: '33101', lon: -80.19, lat: 25.77 },
  { zcta: '33132', lon: -80.18, lat: 25.78 },
  { zcta: '33010', lon: -80.28, lat: 25.86 },
  { zcta: '33030', lon: -80.48, lat: 25.47 },
  { zcta: '33999', lon: -80.19, lat: 27.2 },
  { zcta: '33998', lon: -80.19, lat: 27.24 },
  { zcta: '33040', lon: -81.78, lat: 24.56 },
  { zcta: '32666', lon: -81.6, lat: 29.65 },
  { zcta: '33099', lon: -80.19, lat: 26.0 },
]

const RENTS: Record<string, number> = {
  '33101': 1800,
  '33132': 2100,
  '33010': 1500,
  '33030': 1100,
  '33999': 900,
  '33998': 400,
  '33040': 2400,
  '32666': 519,
  '33099': 300,
}

const ROWS: AreaRow[] = Object.entries(RENTS).map(([zcta, rent]) => ({
  zcta,
  name: `ZCTA5 ${zcta}`,
  metrics: { median_gross_rent: rent, median_home_value: 300000, population: 5000 },
  moes: { median_gross_rent: 50, median_home_value: 20000 },
}))

const SPEC: RadiusFrameSpec = {
  anchorGeography: 'Miami, FL',
  radiusMiles: 100,
  phraseText: 'within 100 miles of Miami',
}

describe('buildRadiusFrameContext', () => {
  it('draws the in-radius set deterministically, anchor included, edge pair split', () => {
    const context = buildRadiusFrameContext({ spec: SPEC, placeIndex: INDEX, centroids: CENTROIDS })
    expect(context).not.toBeNull()
    const zctas = context!.candidateZctas
    // The anchor's own ZIP areas are inside its own radius.
    expect(zctas.has('33101')).toBe(true)
    expect(zctas.has('33132')).toBe(true)
    expect(zctas.has('33010')).toBe(true)
    expect(zctas.has('33030')).toBe(true)
    // Just inside / just outside the stated radius.
    expect(zctas.has('33999')).toBe(true)
    expect(zctas.has('33998')).toBe(false)
    // Beyond the radius entirely.
    expect(zctas.has('33040')).toBe(false)
    expect(zctas.has('32666')).toBe(false)
    expect(context!.candidatePlaceCount).toBe(5)
  })

  it('intersects with the co-named state set the caller supplies', () => {
    const florida = new Set(
      [...BY_ZIP].filter(([, record]) => record.state === 'FL').map(([zip]) => zip),
    )
    const context = buildRadiusFrameContext({
      spec: SPEC,
      placeIndex: INDEX,
      centroids: CENTROIDS,
      restrictZctas: florida,
    })
    // Border Town is inside the radius geographically; its record
    // belongs to GA, so the Florida intersection excludes it.
    expect(context!.candidateZctas.has('33099')).toBe(false)
    expect(context!.candidatePlaceCount).toBe(4)
  })

  it('is null when the anchor has no centroid basis', () => {
    const context = buildRadiusFrameContext({
      spec: SPEC,
      placeIndex: INDEX,
      centroids: CENTROIDS.filter((p) => p.zcta !== '33101' && p.zcta !== '33132'),
    })
    expect(context).toBeNull()
  })
})

describe('the Florida radius specimen, cured', () => {
  it('leads with the cheapest in-radius place, runs no research, accounts the radius from the frame', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent(['FL', 'Miami, FL']),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(['FL', 'Miami, FL']), INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
      centroids: CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(answer?.status).toBe('verified')

    // The radius never reaches the research path for this class.
    expect(researchCalls).toBe(0)

    const names = (answer?.places ?? []).map((p) => p.name)
    // The cheapest place INSIDE the radius leads — not Putnam's
    // $519 (Far North here), not the $400 just outside the edge,
    // not the $300 across the state line of the index record.
    expect(names[0]).toBe('Edge In, FL')
    expect(names).toContain('Miami, FL')
    expect(names).not.toContain('Far North, FL')
    expect(names).not.toContain('Edge Out, FL')
    expect(names).not.toContain('Border Town, GA')
    expect(names).not.toContain('Key West, FL')

    // The radius reading is disclosed as geography.
    const disclosures = answer?.geographyDisclosures ?? []
    expect(
      disclosures.some(
        (line) => line.includes('within 100 miles of Miami, FL') && line.includes('fall inside the radius'),
      ),
    ).toBe(true)

    // The radius criterion is accounted from the frame: measured
    // from the product's own geography, in the reader's words.
    const evidence = answer?.criterionEvidence ?? []
    const radius = evidence.find((e) => e.criterion === 'Within 100 miles of Miami')
    expect(radius?.status).toBe('met')
    expect(radius?.detail).toContain('ZIP-area centroid')
    expect(radius?.detail).toContain('places fall inside it')

    // No per-place distance findings, no research prose anywhere.
    const rendered = [
      answer?.summary ?? '',
      ...(answer?.places ?? []).flatMap((p) => p.claims.map((c) => c.text)),
      ...(answer?.generalClaims ?? []).map((c) => c.text),
      ...evidence.map((e) => `${e.criterion} ${e.detail}`),
    ].join('\n')
    expect(rendered).not.toMatch(/fails (the )?100-mile/i)
    expect(rendered).not.toMatch(/miles (straight|driving)/i)
    expect(answer?.candidateCapApplied).toBe(false)
  })

  it('a genuine second criterion still researches — over the in-radius candidates only', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return {
          prose: 'Homestead, FL schools are served by well-regarded magnet programs in the district.',
          sources: [{ title: 'Homestead schools profile', url: 'https://example.org/homestead-schools' }],
        }
      },
    })
    const question = "What's the cheapest place to live in Florida within 100 miles of Miami with good schools?"
    const answer = await composeAnswerForRequest({
      intent: intent(['FL', 'Miami, FL']),
      queryText: question,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(['FL', 'Miami, FL']), INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
      centroids: CENTROIDS,
    })
    expect(answer).not.toBeNull()
    // Schools research ran; the radius was not its subject.
    expect(researchCalls).toBeGreaterThan(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    expect(names).not.toContain('Far North, FL')
    expect(names).not.toContain('Edge Out, FL')
    const evidence = answer?.criterionEvidence ?? []
    const radius = evidence.find((e) => e.detail.includes('fall inside it'))
    expect(radius?.status).toBe('met')
    expect(evidence.some((e) => /school/i.test(e.criterion))).toBe(true)
    const rendered = [
      ...(answer?.places ?? []).flatMap((p) => p.claims.map((c) => c.text)),
      ...(answer?.generalClaims ?? []).map((c) => c.text),
    ].join('\n')
    expect(rendered).not.toMatch(/miles/i)
  })

  it('without centroids the frame cannot engage and the shipped path stands', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: '', sources: [] }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent(['FL', 'Miami, FL']),
      queryText: SPECIMEN,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent(['FL', 'Miami, FL']), INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
      centroids: null,
    })
    expect(answer).not.toBeNull()
    const disclosures = answer?.geographyDisclosures ?? []
    expect(disclosures.some((line) => line.includes('fall inside the radius'))).toBe(false)
  })
})
