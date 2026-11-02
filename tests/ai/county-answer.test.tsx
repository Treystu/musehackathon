// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  COUNTY_AGGREGATION_METHOD,
  runAnswerPipeline,
} from '../../src/core/ai/answer'
import { rescueNationalScreen } from '../../src/core/ai/national-screen'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { CountyIndex, type CountyRecord } from '../../src/core/zcta-county-index'

/**
 * County-level answers (2026-11-02 cure): the named county question
 * pinned end to end at the hermetic level — parse rescue, runner,
 * pipeline, card — over fixture rows and a fixture crosswalk.
 *
 * The fixture is built so the aggregation rule decides the answer:
 * Adams County holds the cheapest single ZIP area (80011 at 1200)
 * and would lead on a plain mean (1550), but its population sits in
 * the expensive ZIP area, so the population-weighted county figure
 * is 1830 and Denver County (1600) is the county with the lowest
 * median rent. An implementation that averaged without weights, or
 * ranked ZIP areas and relabelled the winner a county, fails here.
 */

const ROWS: AreaRow[] = [
  {
    zcta: '80301',
    name: 'ZCTA5 80301',
    metrics: { median_gross_rent: 1800, population: 30000, households: 12000 },
    moes: { median_gross_rent: 100, households: 300 },
  },
  {
    zcta: '80302',
    name: 'ZCTA5 80302',
    metrics: { median_gross_rent: 1600, population: 10000, households: 4000 },
    moes: { median_gross_rent: 80, households: 200 },
  },
  {
    zcta: '80202',
    name: 'ZCTA5 80202',
    metrics: { median_gross_rent: 1500, population: 20000, households: 9000 },
    moes: { median_gross_rent: 60, households: 250 },
  },
  {
    zcta: '80203',
    name: 'ZCTA5 80203',
    metrics: { median_gross_rent: 1700, population: 20000, households: 9500 },
    moes: { median_gross_rent: 60, households: 250 },
  },
  {
    zcta: '80011',
    name: 'ZCTA5 80011',
    metrics: { median_gross_rent: 1200, population: 1000, households: 400 },
    moes: { median_gross_rent: 90, households: 40 },
  },
  {
    zcta: '80012',
    name: 'ZCTA5 80012',
    metrics: { median_gross_rent: 1900, population: 9000, households: 3600 },
    moes: { median_gross_rent: 110, households: 180 },
  },
  {
    zcta: '78701',
    name: 'ZCTA5 78701',
    metrics: { median_gross_rent: 900, population: 15000, households: 7000 },
    moes: { median_gross_rent: 50, households: 200 },
  },
]

const COUNTY_BY_ZIP: Record<string, { name: string; state: string }> = {
  '80301': { name: 'Boulder County', state: 'CO' },
  '80302': { name: 'Boulder County', state: 'CO' },
  '80202': { name: 'Denver County', state: 'CO' },
  '80203': { name: 'Denver County', state: 'CO' },
  '80011': { name: 'Adams County', state: 'CO' },
  '80012': { name: 'Adams County', state: 'CO' },
  '78701': { name: 'Travis County', state: 'TX' },
}

const COUNTY_INDEX = new CountyIndex(
  new Map<string, CountyRecord>(
    Object.entries(COUNTY_BY_ZIP).map(([zip, county]) => [
      zip,
      { zip, censusName: county.name, state: county.state },
    ]),
  ),
  [],
)

const PLACE_FIXTURES: (PlaceSuggestion & { censusByZip: Record<string, string> })[] = [
  { displayName: 'Boulder', censusName: 'Boulder city', state: 'CO', isCity: true, zips: ['80301', '80302'], censusByZip: {} },
  { displayName: 'Denver', censusName: 'Denver city', state: 'CO', isCity: true, zips: ['80202', '80203'], censusByZip: {} },
  { displayName: 'Aurora', censusName: 'Aurora city', state: 'CO', isCity: true, zips: ['80011', '80012'], censusByZip: {} },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['78701'], censusByZip: {} },
]
const PLACE_INDEX = new PlaceIndex(
  new Map<string, PlaceRecord>(
    PLACE_FIXTURES.flatMap((place) =>
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
  ),
  PLACE_FIXTURES.map(({ censusByZip: _censusByZip, ...place }) => place),
)

const QUESTION = 'Which county in Colorado has the lowest median rent?'

function rescuedIntent(): ValidatedIntent {
  const rescued = rescueNationalScreen(
    {
      mode: 'lookup',
      geographies: ['Colorado'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    },
    QUESTION,
  )
  if (!rescued) throw new Error('the county question did not rescue to a bounded screen')
  return rescued
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

describe('county question, end to end: "Which county in Colorado has the lowest median rent?"', () => {
  it('rescues to a bounded screen over Colorado, as the place-level questions do', () => {
    expect(rescuedIntent()).toMatchObject({
      mode: 'sweep_filter',
      geographies: ['Colorado'],
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })
  })

  it('composes a verified county-level card, ranked by the population-weighted county figure', async () => {
    const intent = rescuedIntent()
    const answer = await composeAnswerForRequest({
      intent,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent, PLACE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
      countyIndex: COUNTY_INDEX,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.geographyLevel).toBe('county')
    // The crosswalk was supplied, so the level is served, not reported.
    expect(answer?.unsupportedGeography).toBeNull()
    expect(answer?.countyMethod).toBe(COUNTY_AGGREGATION_METHOD)
    // The state bound applied before aggregation: the Texas row is
    // out of scope, and no Texas county appears.
    expect(answer?.screenedCount).toBe(6)
    // Population-weighted county rents: Denver (1500,1700 at equal
    // population) 1600; Boulder (1800@30000, 1600@10000) 1750;
    // Adams (1200@1000, 1900@9000) 1830.
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Denver County, CO',
      'Boulder County, CO',
      'Adams County, CO',
    ])
    const denver = answer?.places[0]
    expect(denver?.memberZctas).toEqual(['80202', '80203'])
    expect(denver?.figures).toEqual([
      { key: 'median_gross_rent', value: 1600, marginOfError: 60, marginApproximate: true },
    ])
    const boulder = answer?.places[1]
    expect(boulder?.figures[0]?.value).toBe(1750)
    expect(boulder?.figures[0]?.marginOfError).toBeCloseTo(Math.sqrt(9100), 10)
    expect(boulder?.figures[0]?.marginApproximate).toBe(true)
    const countyEvidence = answer?.criterionEvidence.find(
      (e) => e.criterion === 'County-level geography',
    )
    expect(countyEvidence?.status).toBe('met')
    expect(countyEvidence?.detail).toBe(COUNTY_AGGREGATION_METHOD)

    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Denver County, CO')
    expect(text).toContain('$1,600/mo')
    // The weighted margin is labelled an approximation on the card.
    expect(text).toContain('approx.')
    expect(text).toContain('2 ZIP areas')
    // The rule is stated on the answer itself.
    expect(text).toContain('overlaps most by land area')
    expect(text).toContain('not official Census county margins')
    // The old gap disclosure is gone, and nothing from Texas leaks in.
    expect(text).not.toContain('County-level figures are not available')
    expect(text).not.toContain('Travis County')
    expect(text).not.toContain('Austin')
    // Order on the card matches the pipeline order.
    expect(text.indexOf('Denver County, CO')).toBeLessThan(text.indexOf('Boulder County, CO'))
    expect(text.indexOf('Boulder County, CO')).toBeLessThan(text.indexOf('Adams County, CO'))
  })

  it('carries summed counts beside the weighted means, with RSS margins not labelled approximate', async () => {
    const answer = await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: ['Colorado'],
        metricKeys: ['median_gross_rent', 'households'],
        filters: [],
        clarificationNeeded: false,
      },
      rows: ROWS,
      geographyZctas: new Set(['80301', '80302', '80202', '80203', '80011', '80012']),
      queryText: QUESTION,
      countyAssignments: COUNTY_INDEX.assignmentsFor(ROWS.map((r) => r.zcta)),
    })
    expect(answer.status).toBe('verified')
    const denver = answer.places.find((p) => p.name === 'Denver County, CO')
    const households = denver?.figures.find((f) => f.key === 'households')
    // 9000 + 9500 summed; sqrt(250^2 + 250^2) by RSS.
    expect(households?.value).toBe(18500)
    expect(households?.marginOfError).toBeCloseTo(Math.sqrt(125000), 10)
    expect(households?.marginApproximate).toBeUndefined()
    const rent = denver?.figures.find((f) => f.key === 'median_gross_rent')
    expect(rent?.marginApproximate).toBe(true)
  })

  it('drops and names a county whose deciding figure cannot be aggregated', async () => {
    const rows: AreaRow[] = [
      ...ROWS.slice(2, 4),
      {
        zcta: '81001',
        name: 'ZCTA5 81001',
        // A rent figure with no population figure: the weighted
        // county mean has no honest weight, so Pueblo County is
        // not measurable and must be dropped and named.
        metrics: { median_gross_rent: 1100, population: null },
        moes: { median_gross_rent: 70 },
      },
    ]
    const assignments = new Map(COUNTY_INDEX.assignmentsFor(rows.map((r) => r.zcta)))
    assignments.set('81001', { name: 'Pueblo County', state: 'CO' })
    const answer = await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: ['Colorado'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      },
      rows,
      geographyZctas: new Set(['80202', '80203', '81001']),
      queryText: QUESTION,
      countyAssignments: assignments,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['Denver County, CO'])
    expect(answer.notMeasurableCounties).toEqual(['Pueblo County, CO'])
    render(<AnswerCard answer={answer} />)
    const text = container.textContent ?? ''
    expect(text).toContain(
      'Pueblo County, CO is not shown because its figures could not be aggregated to county level',
    )
  })

  it('without the crosswalk, the same question keeps the unsupported reporting', async () => {
    const intent = rescuedIntent()
    const answer = await composeAnswerForRequest({
      intent,
      queryText: QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent, PLACE_INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: PLACE_INDEX,
    })
    expect(answer?.geographyLevel).toBe('county')
    expect(answer?.unsupportedGeography).toBe('county')
    expect(answer?.countyMethod).toBeNull()
    const countyEvidence = answer?.criterionEvidence.find(
      (e) => e.criterion === 'County-level geography',
    )
    expect(countyEvidence?.status).toBe('not_measurable')
  })
})
