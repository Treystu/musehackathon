import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import type { ComposedAnswer } from '../../src/core/ai/answer'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * Phase 5 preliminary-first staging (owner addendum, 2026-11-03
 * 23:14 HST): researched/geographic questions were too slow as a
 * CLASS because nothing rendered until research, the bookends,
 * and the Jev loop had all settled. The staging contract pinned
 * here:
 *   - the deterministic screen composition reaches the caller
 *     BEFORE the research stage settles (an onPreliminary event
 *     ahead of the returned promise), carrying the screened
 *     figures and the Census-side measurements as real entries;
 *   - researched criteria ride as 'pending' entries — pending is
 *     shown as pending, never with the no-research failure
 *     wording and never as measured;
 *   - the completed composition replaces it through the return
 *     value, unpreliminarized, with the researched criteria
 *     assessed for real;
 *   - the preliminary costs one deterministic pipeline pass: with
 *     research scripted at 600 ms, the preliminary lands inside
 *     the in-process budget the design sets (5-10 s for the whole
 *     run; the screen composition itself is milliseconds).
 * Fixtures are the Philly near-frame set (live-philly-near.test.ts
 * holds the frame's own pins).
 */

const QUESTION =
  'where near philadelphia has good schools and lower cost of living, within 20 miles (as compared to philadelphia itself).'

const PLACES: PlaceSuggestion[] = [
  { displayName: 'Philadelphia', censusName: 'Philadelphia city', state: 'PA', isCity: true, zips: ['19102', '19103', '19104'] },
  { displayName: 'Bala Cynwyd', censusName: 'Bala Cynwyd CDP', state: 'PA', isCity: true, zips: ['19004'] },
  { displayName: 'Upper Darby', censusName: 'Upper Darby township', state: 'PA', isCity: true, zips: ['19082'] },
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
]

const ROWS: AreaRow[] = [
  { zcta: '19102', name: 'ZCTA5 19102', metrics: { median_gross_rent: 2249, median_home_value: 412200, population: 10000 }, moes: { median_gross_rent: 138, median_home_value: 116598 } },
  { zcta: '19103', name: 'ZCTA5 19103', metrics: { median_gross_rent: 1900, median_home_value: 350000, population: 20000 }, moes: { median_gross_rent: 90, median_home_value: 40000 } },
  { zcta: '19104', name: 'ZCTA5 19104', metrics: { median_gross_rent: 1500, median_home_value: 280000, population: 30000 }, moes: { median_gross_rent: 60, median_home_value: 30000 } },
  { zcta: '19004', name: 'ZCTA5 19004', metrics: { median_gross_rent: 1200, median_home_value: 520000, population: 8000 }, moes: { median_gross_rent: 75, median_home_value: 45000 } },
  { zcta: '19082', name: 'ZCTA5 19082', metrics: { median_gross_rent: 1350, median_home_value: 310000, population: 9000 }, moes: { median_gross_rent: 80, median_home_value: 25000 } },
]

const INTENT: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Philadelphia, PA'],
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}

const RESEARCH = {
  prose:
    'Bala Cynwyd, PA is served by the Lower Merion School District, whose schools are rated among the strongest in the state.',
  sources: [{ title: 'Lower Merion School District profile', url: 'https://example.org/lmsd' }],
}

describe('preliminary-first staging', () => {
  it('the screen composition lands before research settles, criteria pending, then the completion replaces it', async () => {
    const events: string[] = []
    let preliminary: ComposedAnswer | null = null
    let preliminaryAt = 0
    const provider = createStubProvider({
      async research() {
        await new Promise((r) => setTimeout(r, 600))
        return RESEARCH
      },
    })
    const started = performance.now()
    const answer = await composeAnswerForRequest({
      intent: INTENT,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(INTENT, INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
      centroids: CENTROIDS,
      onPreliminary: (pre) => {
        events.push('preliminary')
        preliminary = pre
        preliminaryAt = performance.now() - started
      },
    })
    events.push('final')
    const finalAt = performance.now() - started
    // eslint-disable-next-line no-console
    console.log(`[phase5-timing] preliminary at ${preliminaryAt.toFixed(1)}ms, final at ${finalAt.toFixed(1)}ms (research scripted 600ms)`)

    expect(events).toEqual(['preliminary', 'final'])
    // The preliminary beat the scripted research by a wide margin:
    // it is the in-process screen composition, not a network wait.
    expect(preliminaryAt).toBeLessThan(300)
    expect(finalAt).toBeGreaterThanOrEqual(600)

    expect(preliminary).not.toBeNull()
    expect(preliminary?.preliminary).toBe(true)
    expect((preliminary?.places ?? []).map((p) => p.name).sort()).toEqual([
      'Bala Cynwyd, PA',
      'Upper Darby, PA',
    ])
    const preEvidence = preliminary?.criterionEvidence ?? []
    // The Census-side measurements are real at this stage.
    expect(preEvidence.find((e) => e.detail.includes('strictly below that baseline'))?.status).toBe('met')
    expect(preEvidence.find((e) => e.detail.includes('ZIP-area centroid distance'))?.status).toBe('met')
    // The researched criterion is pending — not failed, not measured.
    const preSchools = preEvidence.find((e) => /school/i.test(e.criterion))
    expect(preSchools?.status).toBe('pending')
    expect(preSchools?.detail).toContain('still running')
    expect(JSON.stringify(preEvidence)).not.toContain('did not return')

    // The completion replaces it: no preliminary flag, schools
    // assessed for real (served for one of the two places).
    expect(answer?.preliminary).toBeUndefined()
    const finalSchools = (answer?.criterionEvidence ?? []).find((e) => /school/i.test(e.criterion))
    expect(finalSchools?.status).toBe('partially_measured')
  })

  it('no onPreliminary subscriber: the run is exactly the shipped one', async () => {
    const provider = createStubProvider({
      async research() {
        return RESEARCH
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
    expect(answer?.status).toBe('verified')
    expect(answer?.preliminary).toBeUndefined()
  })

  it('research off: no preliminary is staged (there is nothing pending)', async () => {
    let fired = false
    const answer = await composeAnswerForRequest({
      intent: INTENT,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(INTENT, INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: INDEX,
      centroids: CENTROIDS,
      onPreliminary: () => {
        fired = true
      },
    })
    expect(fired).toBe(false)
    expect(answer).not.toBeNull()
  })
})
