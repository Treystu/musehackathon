import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'
import {
  buildRadiusFrameContext,
  detectNearFrame,
  detectRadiusFrame,
  radiusPreemptsNear,
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
    // CHANGED (round 2, 2026-11-04): the detector itself now
    // matches the single-geography shape — the genuine Spark
    // parse of the Orlando acceptance question carries the
    // anchor alone, and the round-1 count gate is what kept the
    // frame from ever engaging for it. The discrimination from
    // the near frame moved to radiusPreemptsNear at the call
    // sites (pinned below): the detector matching is not the
    // frame engaging.
    const spec = detectRadiusFrame(SPECIMEN, intent(['Miami, FL']))
    expect(spec?.radiusMiles).toBe(100)
    expect(spec?.anchorGeography).toBe('Miami, FL')
  })

  it('refuses shapes with no stated radius, no anchor, or likeness', () => {
    expect(
      detectRadiusFrame("What's the cheapest place to live in Florida?", intent(['FL', 'Miami, FL'])),
    ).toBeNull()
    expect(
      detectRadiusFrame(
        'What places in Florida are like Miami?',
        intent(['FL', 'Miami, FL']),
      ),
    ).toBeNull()
    // CHANGED (round 2): an intent naming a DIFFERENT place than
    // the phrase (['FL', 'Orlando, FL'] against the Miami
    // specimen) no longer refuses detection — the phrase's own
    // named place is its anchor by grammar, and the reader's
    // words govern; the index resolves the name at build time
    // or the frame does not engage. And an intent carrying only
    // the state (['FL']) anchors on the text-stated name — the
    // genuine Spark sample pinned verbatim in the round-2 block
    // below.
    expect(
      detectRadiusFrame(SPECIMEN, intent(['FL', 'Orlando, FL']))?.anchorGeography,
    ).toBe('Miami')
    expect(detectRadiusFrame(SPECIMEN, intent(['FL']))?.anchorGeography).toBe('Miami')
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

/* ------------------------------------------------------------------ */
/* Round 2 — the genuine Spark intent shapes                           */
/* ------------------------------------------------------------------ */

/**
 * Round 2 (2026-11-04): the round-1 build passed every pin above
 * and did not engage in production for either acceptance
 * question (parent browser acceptance, 13:34–13:50 HST). The
 * pins were built on fabricated intents; the genuine Spark
 * parses, captured from the real intent route (direct surface,
 * two samples per question), differ in the decisive fields —
 * every sample carries metricKeys: [] and clarificationNeeded:
 * true (the run executes only after the reader's measure pick,
 * which merges the measure and preserves the geographies), and
 * the geography lists are not the fabricated pair:
 *   Miami specimen — sample 1: ["FL", "Miami, FL"];
 *                    sample 2: ["FL"] (the anchor dropped).
 *   Orlando question — both samples: ["Orlando, FL"] alone,
 *                    modes lookup and sweep_filter.
 * The fixtures below are those captures, verbatim. Detection is
 * asserted on the raw captures (the AskPanel seam, pre-pick);
 * traversals run their post-pick forms (the measure pick merged:
 * median_gross_rent, clarification cleared — resolveClarification's
 * merge, which never drops a geography).
 */
const ORLANDO_QUESTION = "What's the cheapest place to live within 50 miles of Orlando?"

const REAL_MIAMI_SAMPLE_1: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['FL', 'Miami, FL'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}
const REAL_MIAMI_SAMPLE_2: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['FL'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}
const REAL_ORLANDO_SAMPLE_1: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Orlando, FL'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}
const REAL_ORLANDO_SAMPLE_2: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Orlando, FL'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}

/** A captured intent after the reader's measure pick has merged. */
function postPick(captured: ValidatedIntent): ValidatedIntent {
  return { ...captured, metricKeys: ['median_gross_rent'], clarificationNeeded: false }
}

describe('detectRadiusFrame — the genuine Spark shapes (round 2)', () => {
  it('detects the Miami specimen on both genuine samples', () => {
    const s1 = detectRadiusFrame(SPECIMEN, REAL_MIAMI_SAMPLE_1)
    expect(s1?.radiusMiles).toBe(100)
    expect(s1?.anchorGeography).toBe('Miami, FL')
    // Sample 2 dropped the anchor from the geography list; the
    // reader's words still state it after the phrase, and the
    // spec anchors on the stated name (the index resolves it).
    const s2 = detectRadiusFrame(SPECIMEN, REAL_MIAMI_SAMPLE_2)
    expect(s2?.radiusMiles).toBe(100)
    expect(s2?.anchorGeography).toBe('Miami')
    expect(s2?.phraseText).toBe('within 100 miles of Miami')
  })

  it('detects the Orlando question on both genuine samples (anchor alone)', () => {
    for (const sample of [REAL_ORLANDO_SAMPLE_1, REAL_ORLANDO_SAMPLE_2]) {
      const spec = detectRadiusFrame(ORLANDO_QUESTION, sample)
      expect(spec?.radiusMiles).toBe(50)
      expect(spec?.anchorGeography).toBe('Orlando, FL')
      expect(spec?.phraseText).toBe('within 50 miles of Orlando')
    }
  })
})

describe('radiusPreemptsNear — the reference-signal discrimination (round 2)', () => {
  it('the Orlando acceptance shape preempts: a stated radius, no reference signals', () => {
    const near = detectNearFrame(ORLANDO_QUESTION, REAL_ORLANDO_SAMPLE_2)
    expect(near).not.toBeNull()
    expect(radiusPreemptsNear(ORLANDO_QUESTION, near!)).toBe(true)
  })

  it('the Philadelphia specimen does not preempt: its parenthetical casts the anchor as reference', () => {
    const philly =
      'Where near Philadelphia has good schools and lower cost of living, within 20 miles (as compared to Philadelphia itself)?'
    const phillyIntent: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Philadelphia, PA'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    const near = detectNearFrame(philly, phillyIntent)
    expect(near).not.toBeNull()
    expect(radiusPreemptsNear(philly, near!)).toBe(false)
    // Double protection: the specimen's radius is stated without
    // the of-form, so no radius phrase matches it at all.
    expect(detectRadiusFrame(philly, phillyIntent)).toBeNull()
  })

  it('likeness and an explicit than-<anchor> comparison hold the near frame', () => {
    const base: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['Philadelphia, PA'],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    const likeness = 'What places similar to Philadelphia lie within 20 miles of Philadelphia?'
    expect(radiusPreemptsNear(likeness, detectNearFrame(likeness, base)!)).toBe(false)
    const compared = 'Where within 20 miles of Philadelphia is rent cheaper than Philadelphia?'
    expect(radiusPreemptsNear(compared, detectNearFrame(compared, base)!)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Fabricated Orlando set (round-2 traversals)                         */
/* ------------------------------------------------------------------ */

const R2_PLACES: PlaceSuggestion[] = [
  { displayName: 'Miami', censusName: 'Miami city', state: 'FL', isCity: true, zips: ['33101'] },
  { displayName: 'Homestead', censusName: 'Homestead city', state: 'FL', isCity: true, zips: ['33030'] },
  { displayName: 'Far North', censusName: 'Far North city', state: 'FL', isCity: true, zips: ['32666'] },
  { displayName: 'Orlando', censusName: 'Orlando city', state: 'FL', isCity: true, zips: ['32801'] },
  { displayName: 'Winter Park', censusName: 'Winter Park city', state: 'FL', isCity: true, zips: ['32789'] },
  { displayName: 'Edge Fifty', censusName: 'Edge Fifty city', state: 'FL', isCity: true, zips: ['32899'] },
  { displayName: 'Lakeland', censusName: 'Lakeland city', state: 'FL', isCity: true, zips: ['33801'] },
  { displayName: 'Jacksonville', censusName: 'Jacksonville city', state: 'FL', isCity: true, zips: ['32202'] },
]
const R2_BY_ZIP = new Map<string, PlaceRecord>(
  R2_PLACES.flatMap((place) =>
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
const R2_INDEX = new PlaceIndex(R2_BY_ZIP, R2_PLACES)
// Orlando (28.545, -81.378): Winter Park ~5 mi, Edge Fifty ~49 mi
// (just inside the stated 50), Lakeland ~58 mi (just outside —
// and the cheapest rent in the set), Jacksonville ~125 mi.
const R2_CENTROIDS: ZctaPoint[] = [
  { zcta: '33101', lon: -80.19, lat: 25.77 },
  { zcta: '33030', lon: -80.48, lat: 25.47 },
  { zcta: '32666', lon: -81.6, lat: 29.65 },
  { zcta: '32801', lon: -81.378, lat: 28.545 },
  { zcta: '32789', lon: -81.35, lat: 28.6 },
  { zcta: '32899', lon: -81.378, lat: 29.26 },
  { zcta: '33801', lon: -82.05, lat: 27.95 },
  { zcta: '32202', lon: -81.66, lat: 30.33 },
]
const R2_RENTS: Record<string, number> = {
  '33101': 1800,
  '33030': 1100,
  '32666': 519,
  '32801': 1600,
  '32789': 1400,
  '32899': 800,
  '33801': 500,
  '32202': 900,
}
const R2_ROWS: AreaRow[] = Object.entries(R2_RENTS).map(([zcta, rent]) => ({
  zcta,
  name: `ZCTA5 ${zcta}`,
  metrics: { median_gross_rent: rent, median_home_value: 300000, population: 5000 },
  moes: { median_gross_rent: 50, median_home_value: 20000 },
}))

describe('the genuine shapes, traversed (round 2)', () => {
  it('Miami sample 2 (anchor dropped by the parse) composes the same radius answer as sample 1', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_MIAMI_SAMPLE_2)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: SPECIMEN,
      rows: R2_ROWS,
      resolved: resolveAnswerGeographies(picked, R2_INDEX),
      provider,
      research: true,
      placeIndex: R2_INDEX,
      centroids: R2_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(researchCalls).toBe(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    // Cheapest in-radius leads; the cheapest-overall place
    // outside the radius (Far North, $519) never appears.
    expect(names).toEqual(['Homestead, FL', 'Miami, FL'])
    expect(
      (answer?.geographyDisclosures ?? []).some(
        (line) => line.includes('within 100 miles of Miami, FL') && line.includes('fall inside the radius'),
      ),
    ).toBe(true)
    const radius = (answer?.criterionEvidence ?? []).find(
      (e) => e.criterion === 'Within 100 miles of Miami',
    )
    expect(radius?.status).toBe('met')
  })

  it('Orlando (sweep sample): cheapest in-radius leads, the anchor is inside its own radius, no research', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_ORLANDO_SAMPLE_2)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: ORLANDO_QUESTION,
      rows: R2_ROWS,
      resolved: resolveAnswerGeographies(picked, R2_INDEX),
      provider,
      research: true,
      placeIndex: R2_INDEX,
      centroids: R2_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(researchCalls).toBe(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    expect(names[0]).toBe('Edge Fifty, FL')
    expect(names).toContain('Orlando, FL')
    expect(names).toContain('Winter Park, FL')
    // The cheapest rent in the whole set sits just OUTSIDE the
    // radius (Lakeland, $500): excluded, not researched around.
    expect(names).not.toContain('Lakeland, FL')
    expect(names).not.toContain('Jacksonville, FL')
    const disclosures = answer?.geographyDisclosures ?? []
    expect(
      disclosures.some(
        (line) =>
          line.includes('within 50 miles of Orlando, FL') &&
          line.includes('3 places fall inside the radius') &&
          line.includes('ZIP-area centroid'),
      ),
    ).toBe(true)
    // The near frame's reference disclosure is NOT this answer's.
    expect(disclosures.some((line) => line.includes('comparison reference'))).toBe(false)
    const radius = (answer?.criterionEvidence ?? []).find(
      (e) => e.criterion === 'Within 50 miles of Orlando',
    )
    expect(radius?.status).toBe('met')
    const rendered = [
      answer?.summary ?? '',
      ...(answer?.places ?? []).flatMap((p) => p.claims.map((c) => c.text)),
      ...(answer?.generalClaims ?? []).map((c) => c.text),
    ].join('\n')
    expect(rendered).not.toMatch(/miles (straight|driving)/i)
    expect(rendered).not.toMatch(/not measured here/i)
  })

  it('Orlando (lookup sample): the same in-radius set and reading under the parse\'s other mode label', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_ORLANDO_SAMPLE_1)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: ORLANDO_QUESTION,
      rows: R2_ROWS,
      resolved: resolveAnswerGeographies(picked, R2_INDEX),
      provider,
      research: true,
      placeIndex: R2_INDEX,
      centroids: R2_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(researchCalls).toBe(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    expect(new Set(names)).toEqual(new Set(['Orlando, FL', 'Winter Park, FL', 'Edge Fifty, FL']))
    expect(
      (answer?.geographyDisclosures ?? []).some((line) =>
        line.includes('within 50 miles of Orlando, FL'),
      ),
    ).toBe(true)
  })
})
