// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  extractBareCandidateNames,
  extractCandidateNamesFromProse,
  rankedStateLead,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import type { ZctaPoint } from '../../src/core/map/centroids'

/**
 * Regression battery 2026-11-04 (parent probes on production
 * 7dc627e, 02:55–03:21 HST): four live failures, each pinned here
 * in production shape.
 *  R-A — the demo question ("best schools + fewest fast food")
 *        dead-ended on the no-place note: the findings named their
 *        places in list genres extraction read as nothing, and a
 *        shattered publication label ("News", out of "U.S. News")
 *        recorded as an unmatched place.
 *  R-B — the Philadelphia near frame stamped School quality
 *        partially measured no matter what the assessed places'
 *        findings said (the coverage denominator counted places
 *        research never reached), and the card's overflow line
 *        claimed every shown place met the stated criteria.
 *  R-D — the Colorado answer rendered a research verdict listing
 *        places as meeting ALL criteria that the run had not
 *        assessed (and omitted one it had), while "Cañon City"
 *        vanished from extraction on its non-ASCII letter.
 *  R-E — the state-ranking lead said "states" while district and
 *        territory aggregates ranked inside the list.
 */

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

function cardText(answer: ComposedAnswer): string {
  const render = (node: ReactNode) => act(() => root.render(node))
  render(<AnswerCard answer={answer} />)
  return container.textContent ?? ''
}

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

/* ------------------------------------------------------------------ */
/* R-A — the demo question serves                                      */
/* ------------------------------------------------------------------ */

const Q6 = 'Where can I find the best schools but also the fewest fast food restaurants?'

const Q6_ROWS: AreaRow[] = [
  { zcta: '46032', name: 'Carmel, IN', metrics: { median_gross_rent: 1250 }, moes: { median_gross_rent: 60 } },
  { zcta: '46037', name: 'Fishers, IN', metrics: { median_gross_rent: 1310 }, moes: { median_gross_rent: 55 } },
  { zcta: '46077', name: 'Zionsville, IN', metrics: { median_gross_rent: 1420 }, moes: { median_gross_rent: 70 } },
  { zcta: '23607', name: 'Newport News, VA', metrics: { median_gross_rent: 1100 }, moes: { median_gross_rent: 40 } },
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
] as AreaRow[]

/**
 * Live-shaped findings: a publication citation whose name the
 * sentence split shatters, the places named in the parenthetical
 * list genre, and one standard mention. On the shipped build this
 * prose recorded "News" as an unmatched place and — when the
 * standard mention is absent — yielded no candidate at all.
 */
const Q6_PROSE =
  'U.S. News & World Report ranks public schools in several Indiana suburbs at the top of its list. ' +
  'Carmel, Fishers and Zionsville (all in Indiana) are cited for highly rated public schools and few fast-food outlets. ' +
  'Carmel, IN is described as having the strongest school ratings of the group.'

const Q6_SOURCES = [
  { title: 'U.S. News Best High Schools Rankings', url: 'https://example.org/usnews' },
  { title: 'Indiana school directory', url: 'https://example.org/in-schools' },
]

describe('R-A: extraction reads the list genres and never records a source label', () => {
  it('shared-suffix list: every item becomes a candidate, in prose order', () => {
    expect(
      extractCandidateNamesFromProse('Carmel, Fishers and Zionsville, IN are cited for their schools.'),
    ).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
  })

  it('a list of fully suffixed mentions peels no companions and invents none', () => {
    expect(extractCandidateNamesFromProse('Hilo, HI and Keaau, HI are both on the island.')).toEqual([
      'Hilo, HI',
      'Keaau, HI',
    ])
  })

  it('parenthetical list: the parenthesis state serves every item', () => {
    expect(
      extractCandidateNamesFromProse(
        'Carmel, Fishers and Zionsville (all in Indiana) are cited for their schools.',
      ),
    ).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
  })

  it('the shattered publication label is a fragment, never an unmatched name', () => {
    const bare = extractBareCandidateNames(Q6_PROSE, ['Carmel, IN'], Q6_ROWS, undefined, [
      'U.S. News Best High Schools Rankings',
      'Indiana school directory',
    ])
    expect(bare.unresolved).not.toContain('News')
    expect(bare.ambiguous).not.toContain('News')
    expect(bare.names).not.toContain('News')
  })

  it('the label stays a fragment even with no source list to consult', () => {
    const bare = extractBareCandidateNames(Q6_PROSE, ['Carmel, IN'], Q6_ROWS)
    expect(bare.unresolved).not.toContain('News')
  })

  it('an abbreviation-headed place name still resolves whole (St. Louis)', () => {
    const rows: AreaRow[] = [
      { zcta: '63101', name: 'St. Louis, MO', metrics: { median_gross_rent: 950 }, moes: {} },
    ] as AreaRow[]
    const bare = extractBareCandidateNames('St. Louis is known for its school choices.', [], rows)
    expect(bare.names).toEqual(['St. Louis, MO'])
  })
})

describe('R-A: the demo question cards its places and assesses its criteria', () => {
  it('research-first over list-genre findings: places, evidence, no dead end, no "News"', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: Q6_PROSE, sources: Q6_SOURCES }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ mode: 'lookup', metricKeys: [], clarificationNeeded: true }),
      rows: Q6_ROWS,
      researchQuery: Q6,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.summary).not.toContain('did not produce a place')
    expect(answer.places.map((p) => p.name)).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
    // The publication label appears nowhere in the answer's record.
    expect(answer.unresolvedCandidates).toEqual([])
    expect(answer.researchNamedPlaces).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
    // Both criteria assessed from the research, as the class
    // intends: schools served; fast food count-seeking and served
    // qualitatively, so partially measured — never a dead stamp.
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    const fastFood = answer.criterionEvidence.find((e) => e.criterion === 'Fast food restaurants')
    expect(fastFood?.status).toBe('partially_measured')
  })
})

/* ------------------------------------------------------------------ */
/* Q6 round 2 — route discipline + the near-frame lead                 */
/* ------------------------------------------------------------------ */

describe('Q6 round 2: the national-comparison realization routes research-first', () => {
  it('a placeless screen parse carrying an invented bound serves the demo question research-first', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: Q6_PROSE, sources: Q6_SOURCES }
      },
    })
    // The second parse realization (parent live re-verification on
    // e99a324): the question expressed as a national screen — a
    // retained rent measure and a bound the reader never stated
    // (no figure appears anywhere in the question). On the shipped
    // build the screen-probe veto refused it up front: the bound
    // emptied the screen and the terminal was 0-of-0 with both
    // researched criteria not measurable.
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 100 }],
        clarificationNeeded: false,
      }),
      rows: Q6_ROWS,
      researchQuery: Q6,
      queryText: Q6,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
    expect(answer.researchNamedPlaces).toEqual(['Carmel, IN', 'Fishers, IN', 'Zionsville, IN'])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    const fastFood = answer.criterionEvidence.find((e) => e.criterion === 'Fast food restaurants')
    expect(fastFood?.status).toBe('partially_measured')
    expect(answer.summary).not.toContain('No place in the loaded data')
  })

  it('a reader-stated bound keeps the screen path — the refusal stays legitimate there', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: Q6_PROSE, sources: Q6_SOURCES }
      },
    })
    // The same question with the bound IN the reader's words: the
    // bound is a Census-measure requirement the reader themselves
    // set, so the route discipline does not lift the veto — the
    // screen runs, no loaded place meets the stated bound, and the
    // Census refusal is the honest answer to what was asked.
    const bounded =
      'Where can I find the best schools but also the fewest fast food restaurants, in places with rent under $100?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'sweep_filter',
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 100 }],
        clarificationNeeded: false,
      }),
      rows: Q6_ROWS,
      researchQuery: bounded,
      queryText: bounded,
      provider,
    })
    expect(answer.status).toBe('empty')
    expect(answer.places).toEqual([])
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.summary).toBe('No place in the loaded data meets all of the stated Census criteria.')
  })
})

describe('Q6 round 2: the near-frame lead describes the shown list truthfully', () => {
  const phillyIntent: ValidatedIntent = {
    mode: 'lookup',
    geographies: ['Philadelphia, PA'],
    metricKeys: ['median_gross_rent', 'median_home_value'],
    filters: [],
    clarificationNeeded: false,
  }

  it('a sliced frame list with mixed verdicts: the lead defers the meeting count to the count line', async () => {
    const provider = createStubProvider({
      async research() {
        return {
          prose: PHILLY_PROSE,
          sources: [{ title: 'Regional school directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: phillyIntent,
      queryText: PHILLY_Q,
      rows: PHILLY_ROWS,
      resolved: resolveAnswerGeographies(phillyIntent, PHILLY_INDEX),
      provider,
      research: true,
      placeIndex: PHILLY_INDEX,
      centroids: PHILLY_CENTROIDS,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.placesMeetingAllCriteria).toBe(6)
    // The lead describes the shown list — the first screened places
    // in screening order, with per-place findings — and makes no
    // meeting claim of its own; the count line below the list owns
    // the count, and still states it.
    expect(answer?.summary).toContain(
      'The places below are the first of the screened places, in screening order',
    )
    expect(answer?.summary).not.toContain('meet all of the stated criteria')
    const text = cardText(answer!)
    expect(text).toContain(
      '6 of the 12 places in the screening table meet all of the stated criteria',
    )
  })

  it('a frame list shown in full carries no slice lead', async () => {
    const subsetNames = [
      'Philadelphia',
      'Bala Cynwyd',
      'Upper Darby',
      'Ardmore',
      'Havertown',
      'Drexel Hill',
      'Lansdowne',
    ]
    const subsetPlaces = PHILLY_PLACES.filter((p) => subsetNames.includes(p.displayName))
    const subsetZips = new Set(subsetPlaces.flatMap((p) => p.zips))
    const subsetIndex = new PlaceIndex(
      new Map([...PHILLY_BY_ZIP].filter(([zip]) => subsetZips.has(zip))),
      subsetPlaces,
    )
    const subsetCentroids = PHILLY_CENTROIDS.filter((c) => subsetZips.has(c.zcta))
    const subsetRows = PHILLY_ROWS.filter((r) => subsetZips.has(r.zcta))
    const subsetProse = POSITIVE_SCHOOLS.map(
      (name) =>
        `${name}, PA is served by a school district whose schools are rated among the strongest in the state.`,
    ).join(' ')
    const provider = createStubProvider({
      async research() {
        return {
          prose: subsetProse,
          sources: [{ title: 'Regional school directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: phillyIntent,
      queryText: PHILLY_Q,
      rows: subsetRows,
      resolved: resolveAnswerGeographies(phillyIntent, subsetIndex),
      provider,
      research: true,
      placeIndex: subsetIndex,
      centroids: subsetCentroids,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.length).toBe(6)
    expect(answer?.summary).not.toContain('first of the screened places')
  })
})

/* ------------------------------------------------------------------ */
/* R-D — Colorado: assessed set and rendered claims agree              */
/* ------------------------------------------------------------------ */

const COLORADO_Q = 'what city in Colorado has the best nature and the lowest cost of living?'

const CO_ROWS: AreaRow[] = [
  { zcta: '81001', name: 'Pueblo, CO', metrics: { median_gross_rent: 1050 }, moes: { median_gross_rent: 40 } },
  { zcta: '81501', name: 'Grand Junction, CO', metrics: { median_gross_rent: 1100 }, moes: { median_gross_rent: 45 } },
  { zcta: '81101', name: 'Alamosa, CO', metrics: { median_gross_rent: 850 }, moes: { median_gross_rent: 35 } },
  { zcta: '81130', name: 'Creede, CO', metrics: { median_gross_rent: 700 }, moes: { median_gross_rent: 60 } },
  { zcta: '81212', name: 'Cañon City, CO', metrics: { median_gross_rent: 900 }, moes: { median_gross_rent: 50 } },
] as AreaRow[]

const CO_PROSE =
  'Pueblo, CO sits along the Arkansas River with the Wet Mountains to the west. ' +
  'Grand Junction, CO is ringed by red-rock canyons and the Colorado National Monument. ' +
  'Alamosa, CO borders the Great Sand Dunes and the Sangre de Cristo range. ' +
  'Creede, CO is tucked into the San Juan Mountains beside the Rio Grande headwaters. ' +
  'Cañon City, CO overlooks the Royal Gorge and the Arkansas River canyon. ' +
  'Trinidad, CO rests at the foot of Fishers Peak near Trinidad Lake State Park. ' +
  'Pueblo, Cañon City, Grand Junction, Alamosa, and Trinidad meet ALL the criteria.'

describe('R-D: the Colorado intersection', () => {
  it('Cañon City extracts and resolves on its own name; the verdict claim never renders', async () => {
    const provider = createStubProvider({
      async research() {
        return { prose: CO_PROSE, sources: [{ title: 'Colorado outdoors guide', url: 'https://example.org/co' }] }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['CO'], metricKeys: ['median_gross_rent', 'median_home_value'] }),
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider,
    })
    expect(answer.status).toBe('verified')
    // The assessed set: every place the findings named that Census
    // data carries — Cañon City included, on its own spelling.
    expect(answer.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Pueblo, CO', 'Grand Junction, CO', 'Alamosa, CO', 'Creede, CO', 'Cañon City, CO']),
    )
    // Trinidad is disclosed as unmatched — never as meeting.
    expect(answer.unresolvedCandidates).toEqual(['Trinidad, CO'])
    // The set-verdict claim is dropped and recorded; no rendered
    // text anywhere asserts a meet-all list.
    expect(answer.droppedClaims.some((c) => /meet ALL the criteria/i.test(c.text))).toBe(true)
    const rendered = [
      answer.summary,
      ...answer.places.flatMap((p) => p.claims.map((c) => c.text)),
      ...answer.generalClaims.map((c) => c.text),
    ].join('\n')
    expect(rendered).not.toMatch(/meet ALL the criteria/i)
    // Trinidad's own finding may render as a cited general claim;
    // what may never render is Trinidad as a place the answer
    // assessed or as meeting — it is not among the places.
    expect(answer.places.map((p) => p.name)).not.toContain('Trinidad, CO')
  })
})

/* ------------------------------------------------------------------ */
/* R-B — the near frame: coverage and the meeting count                */
/* ------------------------------------------------------------------ */

const PHILLY_Q =
  'where near philadelphia has good schools and lower cost of living, within 20 miles (as compared to philadelphia itself).'

const PHILLY_PLACES: PlaceSuggestion[] = [
  { displayName: 'Philadelphia', censusName: 'Philadelphia city', state: 'PA', isCity: true, zips: ['19102', '19103', '19104'] },
  { displayName: 'Bala Cynwyd', censusName: 'Bala Cynwyd CDP', state: 'PA', isCity: true, zips: ['19004'] },
  { displayName: 'Upper Darby', censusName: 'Upper Darby township', state: 'PA', isCity: true, zips: ['19082'] },
  { displayName: 'Ardmore', censusName: 'Ardmore CDP', state: 'PA', isCity: true, zips: ['19003'] },
  { displayName: 'Havertown', censusName: 'Havertown CDP', state: 'PA', isCity: true, zips: ['19083'] },
  { displayName: 'Drexel Hill', censusName: 'Drexel Hill CDP', state: 'PA', isCity: true, zips: ['19026'] },
  { displayName: 'Lansdowne', censusName: 'Lansdowne borough', state: 'PA', isCity: true, zips: ['19050'] },
  { displayName: 'Collingdale', censusName: 'Collingdale borough', state: 'PA', isCity: true, zips: ['19023'] },
  { displayName: 'Sharon Hill', censusName: 'Sharon Hill borough', state: 'PA', isCity: true, zips: ['19079'] },
  { displayName: 'Folcroft', censusName: 'Folcroft borough', state: 'PA', isCity: true, zips: ['19032'] },
  { displayName: 'Norwood', censusName: 'Norwood borough', state: 'PA', isCity: true, zips: ['19074'] },
  { displayName: 'Ridley Park', censusName: 'Ridley Park borough', state: 'PA', isCity: true, zips: ['19078'] },
  { displayName: 'Morton', censusName: 'Morton borough', state: 'PA', isCity: true, zips: ['19070'] },
]

const PHILLY_BY_ZIP = new Map<string, PlaceRecord>(
  PHILLY_PLACES.flatMap((place) =>
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

const PHILLY_INDEX = new PlaceIndex(PHILLY_BY_ZIP, PHILLY_PLACES)

const PHILLY_CENTROIDS: ZctaPoint[] = [
  { zcta: '19102', lon: -75.162, lat: 39.95 },
  { zcta: '19103', lon: -75.172, lat: 39.956 },
  { zcta: '19104', lon: -75.21, lat: 39.96 },
  { zcta: '19004', lon: -75.235, lat: 39.998 },
  { zcta: '19082', lon: -75.262, lat: 39.965 },
  { zcta: '19003', lon: -75.29, lat: 40.005 },
  { zcta: '19083', lon: -75.31, lat: 39.98 },
  { zcta: '19026', lon: -75.285, lat: 39.945 },
  { zcta: '19050', lon: -75.275, lat: 39.94 },
  { zcta: '19023', lon: -75.285, lat: 39.925 },
  { zcta: '19079', lon: -75.27, lat: 39.905 },
  { zcta: '19032', lon: -75.285, lat: 39.89 },
  { zcta: '19074', lon: -75.30, lat: 39.885 },
  { zcta: '19078', lon: -75.325, lat: 39.885 },
  { zcta: '19070', lon: -75.33, lat: 39.875 },
]

const CANDIDATE_RENTS: Array<[string, number]> = [
  ['19004', 1200], ['19082', 1350], ['19003', 1500], ['19083', 1250], ['19026', 1150],
  ['19050', 1050], ['19023', 950], ['19079', 980], ['19032', 990], ['19074', 1010],
  ['19078', 1080], ['19070', 1020],
]

const PHILLY_ROWS: AreaRow[] = [
  { zcta: '19102', name: 'ZCTA5 19102', metrics: { median_gross_rent: 2249, population: 10000 }, moes: { median_gross_rent: 138 } },
  { zcta: '19103', name: 'ZCTA5 19103', metrics: { median_gross_rent: 1900, population: 20000 }, moes: { median_gross_rent: 90 } },
  { zcta: '19104', name: 'ZCTA5 19104', metrics: { median_gross_rent: 1500, population: 30000 }, moes: { median_gross_rent: 60 } },
  ...CANDIDATE_RENTS.map(([zcta, rent]) => ({
    zcta,
    name: `ZCTA5 ${zcta}`,
    metrics: { median_gross_rent: rent, population: 5000 },
    moes: { median_gross_rent: 70 },
  })),
] as AreaRow[]

const POSITIVE_SCHOOLS = ['Bala Cynwyd', 'Upper Darby', 'Ardmore', 'Havertown', 'Drexel Hill', 'Lansdowne']
const NEGATIVE_SCHOOLS = ['Collingdale', 'Sharon Hill', 'Folcroft', 'Norwood']

const PHILLY_PROSE = [
  ...POSITIVE_SCHOOLS.map(
    (name) => `${name}, PA is served by a school district whose schools are rated among the strongest in the state.`,
  ),
  ...NEGATIVE_SCHOOLS.map(
    (name) => `${name}, PA school options are limited, with the nearest well-rated school in the next town.`,
  ),
].join(' ')

describe('R-B: near-frame coverage reads against the assessed set; the count line counts meeting', () => {
  it('schools stamps met over the researched subset, and only all-criteria places count as meeting', async () => {
    const provider = createStubProvider({
      async research() {
        return {
          prose: PHILLY_PROSE,
          sources: [{ title: 'Regional school directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const phillyIntent: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Philadelphia, PA'],
      metricKeys: ['median_gross_rent', 'median_home_value'],
      filters: [],
      clarificationNeeded: false,
    }
    const answer = await composeAnswerForRequest({
      intent: phillyIntent,
      queryText: PHILLY_Q,
      rows: PHILLY_ROWS,
      resolved: resolveAnswerGeographies(phillyIntent, PHILLY_INDEX),
      provider,
      research: true,
      placeIndex: PHILLY_INDEX,
      centroids: PHILLY_CENTROIDS,
    })
    expect(answer).not.toBeNull()
    // All twelve in-radius suburbs strictly below the baseline.
    expect(answer?.places.length).toBe(12)
    // Research assessed the capped subset (10) and a serving claim
    // speaks to every one of them: the criterion is measured —
    // the two places beyond the cap are the cap's disclosure, not
    // the criterion's partialness. On the shipped build this
    // stamped partially_measured (10 of 12).
    const schools = answer?.criterionEvidence.find((e) => /school/i.test(e.criterion))
    expect(schools?.status).toBe('met')
    // Meeting-all count: the six places with positive school
    // findings (the rent bound is met by construction); the four
    // negative findings and the two unresearched places are
    // assessed, not meeting.
    expect(answer?.placesMeetingAllCriteria).toBe(6)
    const text = cardText(answer!)
    expect(text).toContain(
      '6 of the 12 places in the screening table meet all of the stated criteria',
    )
    expect(text).not.toContain('more places meet the stated criteria')
  })
})

/* ------------------------------------------------------------------ */
/* R-E — the ranked-state lead names the set it ranks                  */
/* ------------------------------------------------------------------ */

describe('R-E: rankedStateLead wording follows the ranked set', () => {
  const aggregateRow = (code: string, label: string, value: number, moe: number): AreaRow =>
    ({
      zcta: `county:${code}:${label}`,
      name: `${label} state average`,
      state: code,
      metrics: { median_age: value },
      moes: { median_age: moe },
    }) as AreaRow

  it('states only: the shipped wording stands', () => {
    const rows = [aggregateRow('ME', 'Maine', 45, 1), aggregateRow('UT', 'Utah', 32, 1)]
    expect(rankedStateLead(rows, 'median_age', 'descending')).toBe(
      'On the Census figures shown, Maine state average has the highest median age of the states shown.',
    )
  })

  it('a territory aggregate in the set: the lead names states and other Census geographies', () => {
    const rows = [
      aggregateRow('ME', 'Maine', 45, 5),
      aggregateRow('PR', 'Puerto Rico', 44, 2),
      aggregateRow('UT', 'Utah', 32, 2),
    ]
    expect(rankedStateLead(rows, 'median_age', 'descending')).toBe(
      'On the Census figures shown, Maine state average heads the states and other Census geographies ordered by median age, highest first.',
    )
  })

  it('the strong form follows the same noun when the bands carry it', () => {
    const rows = [
      aggregateRow('PR', 'Puerto Rico', 44, 1),
      aggregateRow('ME', 'Maine', 40, 1),
      aggregateRow('UT', 'Utah', 32, 1),
    ]
    expect(rankedStateLead(rows, 'median_age', 'descending')).toBe(
      'On the Census figures shown, Puerto Rico state average has the highest median age of the states and other Census geographies shown.',
    )
  })
})
