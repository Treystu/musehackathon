import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import {
  runSummaryText,
  terminalEntryCount,
  type RunProgressSnapshot,
} from '../../src/core/ai/run-progress'
import { decodePlaces, PlaceIndex } from '../../src/core/zcta-place-index'
import { resolveCandidatesWithIndex } from '../../src/ui/ai/answer-runner'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import type { AreaRow } from '../../src/core/plugins/acs'

/**
 * Lane A11 generality pins (phase 4). Fixtures are the live
 * re-verification sheet's verbatim specimens (production 44f90ff,
 * 2026-11-03 07:00-07:49 HST): the COMPLETE strip's counts against
 * the cards they summarized, the Oregon/Montana resolution misses,
 * and the fragment tokens the unmatched line printed as names.
 * Assertions grow per cure cluster; each cluster's commit names
 * the assertions it added.
 */

function snapshot(partial: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    doneUnits: 1,
    totalUnits: 1,
    criteriaTotal: 1,
    criteriaDone: ['Outside-Census criteria'],
    criteriaFailed: [],
    places: [],
    ...partial,
  }
}

function interimPlaces(count: number): RunProgressSnapshot['places'] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Interim ${i + 1}`,
    zcta: `9000${i}`,
    verdicts: [],
  }))
}

/* ------------------------------------------------------------------ */
/* FM-22 — the COMPLETE strip counts the terminal card's entries       */
/* ------------------------------------------------------------------ */

describe('FM-22 run summary terminal count', () => {
  it('Florida weather specimen: snapshot 3, card 4 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(3) }), 4)).toBe(
      'Complete — 1 of 1 checks done · 4 places assessed',
    )
  })

  it('Montana hiking specimen: snapshot 1, card 3 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(1) }), 3)).toBe(
      'Complete — 1 of 1 checks done · 3 places assessed',
    )
  })

  it('Colorado specimen: snapshot 3, card 5 — the strip reads the card', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(3) }), 5)).toBe(
      'Complete — 1 of 1 checks done · 5 places assessed',
    )
  })

  it('Texas specimen: snapshot 1, card 1 — the consistent case is unchanged', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(1) }), 1)).toBe(
      'Complete — 1 of 1 checks done · 1 place assessed',
    )
  })

  it('a note terminal (0 entries) renders no places clause, however many interim candidates waited', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(2) }), 0)).toBe(
      'Complete — 1 of 1 checks done',
    )
  })

  it('the criteria-done guard survives: a total-failure card claims no assessed places', () => {
    expect(
      runSummaryText(
        snapshot({ places: interimPlaces(2), criteriaDone: [], criteriaFailed: ['Outside-Census criteria'] }),
        2,
      ),
    ).toBe('Complete — 1 of 1 checks done · 1 lookup did not return')
  })

  it('without a terminal count the snapshot count remains the fallback', () => {
    expect(runSummaryText(snapshot({ places: interimPlaces(2) }))).toBe(
      'Complete — 1 of 1 checks done · 2 places assessed',
    )
  })
})

describe('FM-22 terminal entry count', () => {
  const place = (name: string) => ({ zcta: '00000', name, figures: [], claims: [] })

  it('counts the composed places of a strict answer', () => {
    const answer = {
      status: 'verified',
      places: [place('A'), place('B'), place('C')],
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(3)
  })

  it('counts the flexible completion places on a flexible terminal, not the empty strict set', () => {
    const answer = {
      status: 'flexible',
      places: [],
      flexible: {
        prose: 'p',
        figures: [],
        places: [
          { name: 'X', evidenceClass: 'research_named', figures: [] },
          { name: 'Y', evidenceClass: 'model_knowledge', figures: [] },
        ],
      },
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(2)
  })

  it('a flexible status without a completion falls back to the composed places', () => {
    const answer = {
      status: 'flexible',
      places: [place('A')],
    } as unknown as ComposedAnswer
    expect(terminalEntryCount(answer)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* FM-23 — Jacksonville, OR and Livingston, MT are absent from the     */
/* shipped place index's name universe (data-layer absence, proven     */
/* against the real payload; the pipeline's unmatched record is the    */
/* honest terminal, never a guess at a neighboring place)              */
/* ------------------------------------------------------------------ */

const PAYLOAD = join(__dirname, '..', '..', 'public', 'map', 'zcta-places.json')
const placeIndex = new PlaceIndex(
  ...(() => {
    const { byZip, places } = decodePlaces(JSON.parse(readFileSync(PAYLOAD, 'utf8')))
    return [byZip, places] as const
  })(),
)

describe('FM-23 the shipped place index (real payload)', () => {
  it("Jacksonville OR's own ZIP is carried under another place's name", () => {
    // 97530 is Jacksonville's ZIP; the Census largest-overlap rule
    // the index is built on assigns the ZCTA to Ruch CDP.
    expect(placeIndex.lookup('97530')).toMatchObject({
      censusName: 'Ruch CDP',
      displayName: 'Ruch',
      state: 'OR',
    })
    expect(placeIndex.label('97530')).toBe('Ruch, OR')
  })

  it("Livingston MT's own ZIP is carried under another place's name", () => {
    expect(placeIndex.lookup('59047')).toMatchObject({
      censusName: 'Pray CDP',
      displayName: 'Pray',
      state: 'MT',
    })
    expect(placeIndex.label('59047')).toBe('Pray, MT')
  })

  it('no place named Jacksonville exists in Oregon, and none named Livingston in Montana', () => {
    expect(placeIndex.places.some((p) => p.displayName === 'Jacksonville' && p.state === 'OR')).toBe(false)
    expect(placeIndex.places.some((p) => p.displayName === 'Livingston' && p.state === 'MT')).toBe(false)
    expect(placeIndex.search('Jacksonville, OR')).toEqual([])
    expect(placeIndex.search('Livingston, MT')).toEqual([])
  })

  it('the production resolver returns nothing for either name — and resolves the same town where the data carries it', () => {
    expect(resolveCandidatesWithIndex(['Jacksonville, OR'], placeIndex)).toEqual([])
    expect(resolveCandidatesWithIndex(['Livingston, MT'], placeIndex)).toEqual([])
    const fl = resolveCandidatesWithIndex(['Jacksonville, FL'], placeIndex)
    expect(fl).toHaveLength(1)
    expect(fl[0]!.zctas).toContain('32208')
    expect(placeIndex.label('32208')).toBe('Jacksonville, FL')
  })
})

function fm23Intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function fm23Row(zcta: string, name: string, rent: number): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent }, moes: { median_gross_rent: 60 } }
}

async function fm23Run(input: {
  q: string
  geographies: string[]
  rows: AreaRow[]
  prose: string
}): Promise<ComposedAnswer> {
  const provider = createStubProvider({
    async research() {
      return { prose: input.prose, sources: [{ title: 'Findings source', url: 'https://example.com/f' }] }
    },
  })
  return runAnswerPipeline({
    intent: fm23Intent({ geographies: input.geographies }),
    rows: input.rows,
    researchQuery: input.q,
    researchCriteria: [input.q],
    queryText: input.q,
    provider,
    candidateResolver: (names) => resolveCandidatesWithIndex(names, placeIndex),
  })
}

describe('FM-23 pipeline specimens (production resolver, real index)', () => {
  it('Oregon charming: Jacksonville, OR is recorded unmatched and no place is dressed in its name', async () => {
    const answer = await fm23Run({
      q: 'Where in Oregon is the most charming small town?',
      geographies: ['Oregon'],
      rows: [
        fm23Row('97103', 'Astoria, OR', 1150),
        fm23Row('97365', 'Newport, OR', 1200),
        fm23Row('97110', 'Cannon Beach, OR', 1600),
        // The ZCTA the town's ZIP belongs to, under the name the
        // shipped data actually carries for it.
        fm23Row('97530', 'Ruch, OR', 900),
      ],
      prose:
        'Jacksonville, OR is often called the most charming small town in the state, a storybook main street of brick storefronts and historic homes. ' +
        'Its festivals and inns draw weekend visitors year-round.',
    })
    expect(answer.places).toEqual([])
    expect(answer.unresolvedCandidates).toContain('Jacksonville, OR')
    expect(answer.places.some((p) => p.name === 'Jacksonville, OR')).toBe(false)
  })

  it('Montana hiking: bare Livingston is recorded, never resolved; the named towns card', async () => {
    const answer = await fm23Run({
      q: 'What town in Montana has the best access to hiking and wilderness?',
      geographies: ['Montana'],
      rows: [
        fm23Row('59068', 'Red Lodge, MT', 795),
        fm23Row('59758', 'West Yellowstone, MT', 1050),
        fm23Row('59911', 'Bigfork, MT', 1158),
        fm23Row('59047', 'Pray, MT', 700),
        // Same-named rows elsewhere in the loaded set: the bare
        // mention is ambiguous nationally, which is why the live
        // run recorded it rather than resolving it.
        fm23Row('77351', 'Livingston, TX', 950),
        fm23Row('70754', 'Livingston, LA', 900),
      ],
      prose:
        'Red Lodge, MT sits at the foot of the Beartooth Highway with trailheads in every direction. ' +
        'West Yellowstone, MT borders the park entrance and its trail network. ' +
        'Bigfork, MT rests on Flathead Lake beneath Swan Range trails. ' +
        'Livingston is the classic rail town gateway to the Paradise Valley trailheads.',
    })
    expect(answer.places.map((p) => p.name)).toEqual(['Red Lodge, MT', 'West Yellowstone, MT', 'Bigfork, MT'])
    expect(answer.unresolvedCandidates).toContain('Livingston')
    expect(answer.places.some((p) => p.zcta === '59047')).toBe(false)
  })
})
