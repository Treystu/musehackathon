import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * The near Philadelphia specimen, traversed end to end at the
 * runner seam (owner live specimen, 2026-11-03, production
 * 9a75c2f; R24 Jev audit: all six aspects failing, combined 0.00,
 * primary_gap near_frame_candidates). The shipped answer screened
 * ONE ZIP of the anchor city, certified the reference against
 * itself ("0 miles from itself", "lower-cost" than itself), quoted
 * one downtown ZIP's figures as the city's, stamped all three
 * criteria measured, and rendered raw research source titles as
 * prose. This pin holds the cured shape:
 *   - the screened places are the suburbs within the stated
 *     radius, drawn from the product's own centroid geography;
 *   - the reference is absent from the candidates and present as
 *     the baseline — its aggregate figure, formed from all of its
 *     ZIP areas, stated in the cost evidence;
 *   - a candidate pricier than the baseline is screened out by
 *     the relative bound; a cheap place beyond the radius is out
 *     by the frame;
 *   - the frame criterion is measured from the geography itself,
 *     in the reader's words — never "served by the cited sources";
 *   - the schools criterion is measured only where a serving
 *     claim speaks to the place (one of two places here, so
 *     partially measured);
 *   - no raw source title, no meet-all verdict prose, no
 *     reference-only claim, and no research-narration caveat
 *     renders anywhere in the answer; the drops are recorded.
 */

const QUESTION =
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

const CENTROIDS: ZctaPoint[] = [
  { zcta: '19102', lon: -75.162, lat: 39.95 },
  { zcta: '19103', lon: -75.172, lat: 39.956 },
  { zcta: '19104', lon: -75.21, lat: 39.96 },
  { zcta: '19004', lon: -75.235, lat: 39.998 },
  { zcta: '19082', lon: -75.262, lat: 39.965 },
  { zcta: '19406', lon: -75.385, lat: 40.092 },
  { zcta: '18101', lon: -75.49, lat: 40.602 },
]

/** ACS-shaped rows: the place-index join supplies the display names. */
const ROWS: AreaRow[] = [
  { zcta: '19102', name: 'ZCTA5 19102', metrics: { median_gross_rent: 2249, median_home_value: 412200, population: 10000 }, moes: { median_gross_rent: 138, median_home_value: 116598 } },
  { zcta: '19103', name: 'ZCTA5 19103', metrics: { median_gross_rent: 1900, median_home_value: 350000, population: 20000 }, moes: { median_gross_rent: 90, median_home_value: 40000 } },
  { zcta: '19104', name: 'ZCTA5 19104', metrics: { median_gross_rent: 1500, median_home_value: 280000, population: 30000 }, moes: { median_gross_rent: 60, median_home_value: 30000 } },
  { zcta: '19004', name: 'ZCTA5 19004', metrics: { median_gross_rent: 1200, median_home_value: 520000, population: 8000 }, moes: { median_gross_rent: 75, median_home_value: 45000 } },
  { zcta: '19082', name: 'ZCTA5 19082', metrics: { median_gross_rent: 1350, median_home_value: 310000, population: 9000 }, moes: { median_gross_rent: 80, median_home_value: 25000 } },
  { zcta: '19406', name: 'ZCTA5 19406', metrics: { median_gross_rent: 2600, median_home_value: 480000, population: 7000 }, moes: { median_gross_rent: 110, median_home_value: 50000 } },
  { zcta: '18101', name: 'ZCTA5 18101', metrics: { median_gross_rent: 900, median_home_value: 240000, population: 6000 }, moes: { median_gross_rent: 50, median_home_value: 20000 } },
]

const INTENT: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Philadelphia, PA'],
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}

/**
 * The research material, shaped on the specimen's failure modes:
 * one genuine per-place finding (Bala Cynwyd only), a garbled
 * concatenation of two source titles (neither verbatim — a suffix
 * dropped from each), the model's own meet-all verdict prose about
 * the reference, a reference-only claim, and a research-narration
 * caveat. Every defective sentence must be dropped and recorded;
 * the genuine finding must land on its place.
 */
const RESEARCH_PROSE = [
  'Bala Cynwyd, PA is served by the Lower Merion School District, whose schools are rated among the strongest in the state.',
  'Schools in Philadelphia, Pennsylvania (Elementary, Middle High Schools) Best Public Schools in Bala Cynwyd, PA',
  'Meets ALL reader criteria on available evidence: Philadelphia, PA is 0 miles from itself.',
  'Philadelphia, PA district schools include nationally ranked magnet options.',
  'The web does not support a blanket claim that all Philadelphia schools are high-performing.',
].join(' ')

const RESEARCH_SOURCES = [
  { title: 'Schools in Philadelphia, Pennsylvania (Elementary, Middle and High Schools)', url: 'https://example.org/philly-schools' },
  { title: 'Best Public Schools in Bala Cynwyd, PA (2026-27)', url: 'https://example.org/bala-schools' },
  { title: 'Lower Merion School District profile', url: 'https://example.org/lmsd' },
]

describe('the near Philadelphia specimen, cured', () => {
  it('screens the suburbs, holds the reference as baseline, and renders no narration', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: RESEARCH_PROSE, sources: RESEARCH_SOURCES }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: INTENT,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(INTENT, INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
      centroids: CENTROIDS,
    })
    expect(answer).not.toBeNull()
    expect(answer?.status).toBe('verified')

    // The candidate set: the two in-radius suburbs strictly below
    // the baseline. King of Prussia (in radius, $2,600 rent) is out
    // on the relative bound; Allentown ($900, ~48 miles) is out on
    // the frame; the reference itself is never a candidate.
    const names = (answer?.places ?? []).map((p) => p.name).sort()
    expect(names).toEqual(['Bala Cynwyd, PA', 'Upper Darby, PA'])

    // The reference disclosure replaces the single-ZIP disclosure:
    // the baseline is formed from all of the anchor's ZIP areas.
    const disclosures = answer?.geographyDisclosures ?? []
    expect(disclosures.some((line) => line.includes('comparison reference'))).toBe(true)
    expect(disclosures.some((line) => line.includes('spans'))).toBe(false)

    // Criteria evidence: the cost reading names the baseline
    // figure — the aggregate of all three anchor ZIP areas
    // ($1,758), not the first ZIP's $2,249.
    const evidence = answer?.criterionEvidence ?? []
    const cost = evidence.find((e) => e.detail.includes('strictly below that baseline'))
    expect(cost?.status).toBe('met')
    expect(cost?.detail).toContain('$1,758')
    expect(cost?.detail).toContain('all 3 of its ZIP areas')
    expect(cost?.detail).not.toContain('$2,249')

    // The frame criterion is measured from the product's own
    // geography, in the reader's words.
    const frame = evidence.find((e) => e.detail.includes('ZIP-area centroid distance'))
    expect(frame?.status).toBe('met')
    expect(frame?.detail).toContain('not one of the candidates')

    // Schools: served for Bala Cynwyd only, so partially measured
    // — never stamped measured off material about the reference.
    const schools = evidence.find((e) => /school/i.test(e.criterion))
    expect(schools?.status).toBe('partially_measured')

    // The genuine finding landed on its place; the other place
    // carries no claim it was never given.
    const bala = answer?.places.find((p) => p.name === 'Bala Cynwyd, PA')
    expect(bala?.claims.some((c) => c.text.includes('Lower Merion School District'))).toBe(true)
    const darby = answer?.places.find((p) => p.name === 'Upper Darby, PA')
    expect(darby?.claims).toEqual([])

    // Rendering hygiene over everything the card can show: no raw
    // title text, no verdict prose, no reference-only claim, no
    // narration caveat. The drops are recorded, not silent.
    const rendered = [
      answer?.summary ?? '',
      ...(answer?.places ?? []).flatMap((p) => p.claims.map((c) => c.text)),
      ...(answer?.generalClaims ?? []).map((c) => c.text),
      ...evidence.map((e) => `${e.criterion} ${e.detail}`),
    ].join('\n')
    expect(rendered).not.toContain('Best Public Schools')
    expect(rendered).not.toContain('Elementary, Middle')
    expect(rendered).not.toMatch(/meets all reader criteria/i)
    expect(rendered).not.toContain('0 miles from itself')
    expect(rendered).not.toContain('nationally ranked magnet')
    expect(rendered).not.toContain('blanket claim')
    expect(answer?.droppedClaims.length).toBeGreaterThanOrEqual(3)
  })

  it('without centroids the frame cannot engage and the shipped path stands', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: RESEARCH_PROSE, sources: RESEARCH_SOURCES }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: INTENT,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(INTENT, INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
    })
    // The shipped single-ZIP lookup of the anchor: the reference
    // is the place shown, exactly as before this cure.
    expect(answer?.places.map((p) => p.name)).toEqual(['Philadelphia, PA'])
  })
})
