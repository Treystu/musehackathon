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
    // CHANGED (round 3): the anchor the fallback and
    // mismatched-intent shapes produce is state-qualified by
    // the co-named state geography ('Miami, FL', not 'Miami') —
    // a bare same-named place resolves in the index's baked
    // order (bare 'Houston' resolves to Houston, AK), so the
    // unqualified spec's resolution was index-order luck. The
    // resolution for this specimen is unchanged: Miami, FL is
    // where both forms land, now by suffix rather than by luck.
    expect(
      detectRadiusFrame(SPECIMEN, intent(['FL', 'Orlando, FL']))?.anchorGeography,
    ).toBe('Miami, FL')
    expect(detectRadiusFrame(SPECIMEN, intent(['FL']))?.anchorGeography).toBe('Miami, FL')
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
    // CHANGED (round 3): the stated name is state-qualified by
    // the co-named state geography — 'Miami, FL', not 'Miami' —
    // so its resolution no longer rides on the index's baked
    // order (the Houston round-3 block below is the shape that
    // order defeats). The resolved anchor is the same place.
    const s2 = detectRadiusFrame(SPECIMEN, REAL_MIAMI_SAMPLE_2)
    expect(s2?.radiusMiles).toBe(100)
    expect(s2?.anchorGeography).toBe('Miami, FL')
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

/* ------------------------------------------------------------------ */
/* Round 3 — the Houston question                                      */
/* ------------------------------------------------------------------ */

/**
 * Round 3 (2026-11-04): on the round-2 build the parent's
 * browser acceptance passes Miami and Orlando and fails the
 * Houston question — "What's the cheapest place to live in
 * Texas within 200 miles of Houston?" took the research path
 * ("Outside-Census criteria — measured. Served by the cited
 * sources"), presented the statewide cheapest list (nine of
 * the ten shown places 400–600 miles away), and stated no
 * in-radius count and no distance basis. The genuine parses —
 * three draws from the real intent route (direct surface, the
 * panel's exact request), plus a Miami control draw that
 * reproduced round 2's sample 1 verbatim — split by shape:
 *   Houston draws 2 and 3 (byte-identical): ["TX",
 *     "Houston, TX"] — the anchor carried as a geography; that
 *     shape detects, builds, and traverses on the round-2 code.
 *   Houston draw 1: ["TX"] — the anchor dropped, the Miami
 *     sample-2 shape. The words fallback anchors on the stated
 *     name "Houston", and a bare same-named place resolves in
 *     the shipped index's baked order, where Houston, AK
 *     stands first of seven Houstons (measured against the
 *     real index: anchorHitFor("Houston") -> Houston, AK
 *     99694; the Texas-intersected context build on that
 *     anchor -> null). The frame therefore never engaged on
 *     this shape, and the shipped research path stood. Miami's
 *     identical shape engaged live only because Miami, FL
 *     sorts first among the Miamis; a spelled-out suffix fails
 *     symmetrically (anchorHitFor("Houston, Texas") -> null:
 *     the index's suffix reading knows only two-letter codes).
 * The cure (near-frame.ts): the spec's anchor geography is
 * state-qualified whenever a state is known — its own suffix
 * normalized to its code, or the co-named state geography for a
 * bare name — so the explicit radius phrase engages on every
 * parse shape.
 *
 * Two further defects from the same acceptance round are
 * pinned below: the card's remainder counted ZIP-area entries
 * while the radius disclosure counts place records (defect 2),
 * and the lead row of a radius-framed answer could be a ZIP
 * area whose own centroid lies outside the radius (defect 3,
 * the GPT audit lane's centroid verification — the live Miami
 * lead, Port St. Lucie 34945 at $747, is 112.6 miles from the
 * nearest Miami centroid; its place qualified through sibling
 * 34984 at 96.8 miles).
 */
const HOUSTON_QUESTION =
  "What's the cheapest place to live in Texas within 200 miles of Houston?"

const REAL_HOUSTON_SAMPLE_1: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['TX'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}
const REAL_HOUSTON_SAMPLE_2: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['TX', 'Houston, TX'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
  domain: 'data_with_gaps',
}

describe('detectRadiusFrame — the Houston shapes (round 3)', () => {
  it('detects on every genuine draw, the anchor state-qualified on each', () => {
    for (const sample of [REAL_HOUSTON_SAMPLE_1, REAL_HOUSTON_SAMPLE_2]) {
      const spec = detectRadiusFrame(HOUSTON_QUESTION, sample)
      expect(spec?.radiusMiles).toBe(200)
      expect(spec?.anchorGeography).toBe('Houston, TX')
      expect(spec?.phraseText).toBe('within 200 miles of Houston')
    }
  })

  it('normalizes a spelled-out state suffix on the anchor geography', () => {
    // The index's suffix reading knows only two-letter codes,
    // so this geography resolved to no anchor at all before the
    // cure; its shape is draw 2's with both state names spelled
    // out, as the model also writes them.
    const spelled: ValidatedIntent = {
      ...REAL_HOUSTON_SAMPLE_2,
      geographies: ['Texas', 'Houston, Texas'],
    }
    const spec = detectRadiusFrame(HOUSTON_QUESTION, spelled)
    expect(spec?.radiusMiles).toBe(200)
    expect(spec?.anchorGeography).toBe('Houston, TX')
  })

  it('qualifies a bare anchor geography with the co-named state', () => {
    const bare: ValidatedIntent = {
      ...REAL_HOUSTON_SAMPLE_2,
      geographies: ['TX', 'Houston'],
    }
    expect(detectRadiusFrame(HOUSTON_QUESTION, bare)?.anchorGeography).toBe('Houston, TX')
  })
})

/* ------------------------------------------------------------------ */
/* Fabricated Texas set (round-3 traversals)                           */
/* ------------------------------------------------------------------ */

// Fourteen place records fall inside the stated 200 miles; the
// answer's place list carries seventeen entries, because the
// anchor, Katy, and Split Town contribute two ZIP areas each —
// the records vs ZIP-area entries split behind the acceptance's
// remainder defect (defect 2). Split Town is the synthetic
// defect-3 place: its cheapest ZIP (77099, $500) sits ~213
// miles away, outside the radius, while its sibling 77100
// (~17 miles) qualifies the place — the lead must follow the
// qualifying ZIP. Far West holds the cheapest rent in the set
// and sits ~670 miles away: outside the radius, excluded
// entirely.
const R3_PLACES: PlaceSuggestion[] = [
  { displayName: 'Houston', censusName: 'Houston city', state: 'TX', isCity: true, zips: ['77002', '77003'] },
  { displayName: 'Baytown', censusName: 'Baytown city', state: 'TX', isCity: true, zips: ['77520'] },
  { displayName: 'Pasadena', censusName: 'Pasadena city', state: 'TX', isCity: true, zips: ['77502'] },
  { displayName: 'Katy', censusName: 'Katy city', state: 'TX', isCity: true, zips: ['77494', '77450'] },
  { displayName: 'Split Town', censusName: 'Split Town city', state: 'TX', isCity: true, zips: ['77099', '77100'] },
  { displayName: 'Texas City', censusName: 'Texas City city', state: 'TX', isCity: true, zips: ['77590'] },
  { displayName: 'Conroe', censusName: 'Conroe city', state: 'TX', isCity: true, zips: ['77301'] },
  { displayName: 'Huntsville', censusName: 'Huntsville city', state: 'TX', isCity: true, zips: ['77340'] },
  { displayName: 'Beaumont', censusName: 'Beaumont city', state: 'TX', isCity: true, zips: ['77701'] },
  { displayName: 'Port Arthur', censusName: 'Port Arthur city', state: 'TX', isCity: true, zips: ['77640'] },
  { displayName: 'College Station', censusName: 'College Station city', state: 'TX', isCity: true, zips: ['77840'] },
  { displayName: 'Lufkin', censusName: 'Lufkin city', state: 'TX', isCity: true, zips: ['75901'] },
  { displayName: 'Victoria', censusName: 'Victoria city', state: 'TX', isCity: true, zips: ['77901'] },
  { displayName: 'Waco', censusName: 'Waco city', state: 'TX', isCity: true, zips: ['76701'] },
  { displayName: 'Far West', censusName: 'Far West city', state: 'TX', isCity: true, zips: ['79901'] },
]
const R3_BY_ZIP = new Map<string, PlaceRecord>(
  R3_PLACES.flatMap((place) =>
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
const R3_INDEX = new PlaceIndex(R3_BY_ZIP, R3_PLACES)
// Houston (29.76, -95.37): every place below is inside 200
// miles (Waco the farthest at ~160) except Far West (~670) and
// Split Town's far ZIP 77099 (~213).
const R3_CENTROIDS: ZctaPoint[] = [
  { zcta: '77002', lon: -95.37, lat: 29.76 },
  { zcta: '77003', lon: -95.35, lat: 29.74 },
  { zcta: '77520', lon: -94.965, lat: 29.745 },
  { zcta: '77502', lon: -95.209, lat: 29.691 },
  { zcta: '77494', lon: -95.825, lat: 29.786 },
  { zcta: '77450', lon: -95.76, lat: 29.774 },
  { zcta: '77099', lon: -95.37, lat: 32.85 },
  { zcta: '77100', lon: -95.6, lat: 29.9 },
  { zcta: '77590', lon: -94.902, lat: 29.384 },
  { zcta: '77301', lon: -95.456, lat: 30.312 },
  { zcta: '77340', lon: -95.551, lat: 30.723 },
  { zcta: '77701', lon: -94.127, lat: 30.08 },
  { zcta: '77640', lon: -93.93, lat: 29.885 },
  { zcta: '77840', lon: -96.334, lat: 30.628 },
  { zcta: '75901', lon: -94.729, lat: 31.338 },
  { zcta: '77901', lon: -97.003, lat: 28.805 },
  { zcta: '76701', lon: -97.147, lat: 31.549 },
  { zcta: '79901', lon: -106.487, lat: 31.759 },
]
const R3_RENTS: Record<string, number> = {
  '77002': 1800,
  '77003': 1900,
  '77520': 700,
  '77502': 850,
  '77494': 950,
  '77450': 990,
  '77099': 500,
  '77100': 640,
  '77590': 880,
  '77301': 800,
  '77340': 820,
  '77701': 750,
  '77640': 760,
  '77840': 900,
  '75901': 780,
  '77901': 720,
  '76701': 690,
  '79901': 300,
}
const R3_ROWS: AreaRow[] = Object.entries(R3_RENTS).map(([zcta, rent]) => ({
  zcta,
  name: `ZCTA5 ${zcta}`,
  metrics: { median_gross_rent: rent, median_home_value: 300000, population: 5000 },
  moes: { median_gross_rent: 50, median_home_value: 20000 },
}))

describe('the Houston question, traversed on the genuine shapes (round 3)', () => {
  it('draw 1 (anchor dropped): the radius answer composes — qualifying lead, no research, the frame count stated', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_HOUSTON_SAMPLE_1)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: HOUSTON_QUESTION,
      rows: R3_ROWS,
      resolved: resolveAnswerGeographies(picked, R3_INDEX),
      provider,
      research: true,
      placeIndex: R3_INDEX,
      centroids: R3_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(answer?.status).toBe('verified')
    // The pure radius class never reaches research.
    expect(researchCalls).toBe(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    // The cheapest place in the state ($300, ~670 miles away)
    // never appears.
    expect(names).not.toContain('Far West, TX')
    expect(names).toContain('Waco, TX')
    expect(names).toContain('Houston, TX')
    // The radius reading is disclosed, with its count and basis.
    expect(
      (answer?.geographyDisclosures ?? []).some(
        (line) =>
          line.includes('within 200 miles of Houston, TX') &&
          line.includes('14 places fall inside the radius') &&
          line.includes('ZIP-area centroid'),
      ),
    ).toBe(true)
    const radius = (answer?.criterionEvidence ?? []).find(
      (e) => e.criterion === 'Within 200 miles of Houston',
    )
    expect(radius?.status).toBe('met')
    expect(radius?.detail).toContain('places fall inside it')
  })

  it('the lead follows the qualifying ZIP: Split Town fronts 77100, not its cheaper out-of-radius 77099 (defect 3, synthetic)', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_HOUSTON_SAMPLE_1)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: HOUSTON_QUESTION,
      rows: R3_ROWS,
      resolved: resolveAnswerGeographies(picked, R3_INDEX),
      provider,
      research: true,
      placeIndex: R3_INDEX,
      centroids: R3_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    const places = answer?.places ?? []
    // Split Town's cheapest ZIP (77099, $500) is itself outside
    // the radius; the lead is the qualifying sibling's row,
    // carrying the sibling's own figure ($640) — the lead
    // figure changing is the correct behavior, not a regression.
    expect(places[0]?.name).toBe('Split Town, TX')
    expect(places[0]?.zcta).toBe('77100')
    expect(
      places[0]?.figures.find((f) => f.key === 'median_gross_rent')?.value,
    ).toBe(640)
    // Membership is kept: the out-of-radius ZIP's row remains
    // in the answer, behind every qualifying row.
    expect(places[places.length - 1]?.zcta).toBe('77099')
    expect(answer?.radiusQualifyingZctas).toContain('77100')
    expect(answer?.radiusQualifyingZctas).not.toContain('77099')
  })

  it('draw 2 (anchor carried): the identical radius answer — engagement independent of parse shape', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_HOUSTON_SAMPLE_2)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: HOUSTON_QUESTION,
      rows: R3_ROWS,
      resolved: resolveAnswerGeographies(picked, R3_INDEX),
      provider,
      research: true,
      placeIndex: R3_INDEX,
      centroids: R3_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(researchCalls).toBe(0)
    const names = (answer?.places ?? []).map((p) => p.name)
    expect(names[0]).toBe('Split Town, TX')
    expect(answer?.places[0]?.zcta).toBe('77100')
    expect(names).not.toContain('Far West, TX')
    expect(answer?.radiusPlaceTotal).toBe(14)
  })

  it('the remainder arithmetic: the frame total, not the ZIP-area entry count (defect 2)', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_HOUSTON_SAMPLE_1)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: HOUSTON_QUESTION,
      rows: R3_ROWS,
      resolved: resolveAnswerGeographies(picked, R3_INDEX),
      provider,
      research: true,
      placeIndex: R3_INDEX,
      centroids: R3_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    // The two counts the acceptance caught contradicting each
    // other: 14 place RECORDS fall inside the radius; the
    // answer's list carries 17 entries (the anchor, Katy, and
    // Split Town contribute two ZIP areas each). The card shows
    // 10 entries (ANSWER_CARD_PLACE_LIMIT) and its overflow
    // line reads the remainder from the frame total the answer
    // states: 14 - 10 = 4 more places — never the entry
    // count's 17 - 10.
    expect(answer?.radiusPlaceTotal).toBe(14)
    expect(answer?.places.length).toBe(17)
    expect(answer!.radiusPlaceTotal! - 10).toBe(4)
    expect(answer!.places.length - 10).toBe(7)
  })
})

/* ------------------------------------------------------------------ */
/* Round 3 — the Port St. Lucie lead (defect 3, the live geometry)     */
/* ------------------------------------------------------------------ */

/**
 * The live Miami geometry, fabricated at its measured
 * distances: Port St. Lucie qualifies as a place through ZIP
 * 34984 (~97 miles from the anchor's nearest centroid, inside
 * the stated 100), while its cheapest ZIP 34945 (~113 miles)
 * is itself outside — the live answer led with 34945 at $747.
 * Here 34984 carries $812: the cured lead is 34984 with its own
 * figure, and the $747 row keeps its membership behind the
 * qualifying rows.
 */
const R3B_PLACES: PlaceSuggestion[] = [
  { displayName: 'Miami', censusName: 'Miami city', state: 'FL', isCity: true, zips: ['33150', '33101'] },
  { displayName: 'Hialeah', censusName: 'Hialeah city', state: 'FL', isCity: true, zips: ['33010'] },
  { displayName: 'Port St. Lucie', censusName: 'Port St. Lucie city', state: 'FL', isCity: true, zips: ['34984', '34945'] },
  { displayName: 'Far North', censusName: 'Far North city', state: 'FL', isCity: true, zips: ['32666'] },
]
const R3B_BY_ZIP = new Map<string, PlaceRecord>(
  R3B_PLACES.flatMap((place) =>
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
const R3B_INDEX = new PlaceIndex(R3B_BY_ZIP, R3B_PLACES)
// Anchor at (25.80, -80.20): 34984 is 1.40 degrees of latitude
// north (~97 miles, inside); 34945 is 1.63 degrees (~113
// miles, outside); Far North is far outside.
const R3B_CENTROIDS: ZctaPoint[] = [
  { zcta: '33150', lon: -80.2, lat: 25.8 },
  { zcta: '33101', lon: -80.19, lat: 25.77 },
  { zcta: '33010', lon: -80.28, lat: 25.86 },
  { zcta: '34984', lon: -80.2, lat: 27.2 },
  { zcta: '34945', lon: -80.2, lat: 27.43 },
  { zcta: '32666', lon: -81.6, lat: 29.65 },
]
const R3B_RENTS: Record<string, number> = {
  '33150': 2100,
  '33101': 1800,
  '33010': 1500,
  '34984': 812,
  '34945': 747,
  '32666': 519,
}
const R3B_ROWS: AreaRow[] = Object.entries(R3B_RENTS).map(([zcta, rent]) => ({
  zcta,
  name: `ZCTA5 ${zcta}`,
  metrics: { median_gross_rent: rent, median_home_value: 300000, population: 5000 },
  moes: { median_gross_rent: 50, median_home_value: 20000 },
}))

describe('the Port St. Lucie lead, cured (round 3, defect 3)', () => {
  it('the lead row is the qualifying ZIP with its own figure; the out-of-radius ZIP keeps its membership', async () => {
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        return { prose: '', sources: [] }
      },
    })
    const picked = postPick(REAL_MIAMI_SAMPLE_1)
    const answer = await composeAnswerForRequest({
      intent: picked,
      queryText: SPECIMEN,
      rows: R3B_ROWS,
      resolved: resolveAnswerGeographies(picked, R3B_INDEX),
      provider,
      research: true,
      placeIndex: R3B_INDEX,
      centroids: R3B_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(researchCalls).toBe(0)
    const places = answer?.places ?? []
    expect(places[0]?.name).toBe('Port St. Lucie, FL')
    expect(places[0]?.zcta).toBe('34984')
    expect(
      places[0]?.figures.find((f) => f.key === 'median_gross_rent')?.value,
    ).toBe(812)
    // 34945 remains a member (its place qualified), shown
    // behind the qualifying rows — not deleted, not fronted.
    expect(places.map((p) => p.zcta)).toContain('34945')
    expect(places[places.length - 1]?.zcta).toBe('34945')
    expect(places.map((p) => p.name)).not.toContain('Far North, FL')
    expect(answer?.radiusPlaceTotal).toBe(3)
    expect(answer?.radiusQualifyingZctas).toContain('34984')
    expect(answer?.radiusQualifyingZctas).not.toContain('34945')
  })
})
