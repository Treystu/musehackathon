import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { runAnswerPipeline } from '../../src/core/ai/answer'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import {
  progressPercent,
  type RunProgressSnapshot,
} from '../../src/core/ai/run-progress'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'

/**
 * Lane A7 emission pins (design record: drive-scratch/
 * progressive-loading). The pipeline emits a RunProgressSnapshot
 * when research begins and at every pass boundary — including a
 * tolerated failure — through the onProgress seam; the candidate
 * set and verdicts in each snapshot are the terminal path's own
 * (screen candidates on the screen-first path, provisionally
 * extracted + resolved candidates, growing per pass, on the
 * research-first path). Shapes with no research emit nothing:
 * those runs have no honest percent and the stage line carries
 * them. The runner forwards progress from the first pipeline run
 * only.
 */

const HILO_ROWS: AreaRow[] = [
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
  { zcta: '96749', name: 'Keaau, HI', metrics: { median_gross_rent: 1325 }, moes: { median_gross_rent: 120 } },
  { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1750 }, moes: { median_gross_rent: 150 } },
]

const HILO_SCREEN: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const STARBUCKS_QUESTION =
  'Where in Hilo has the best schools and affordable housing, with a Starbucks nearby?'

function collector() {
  const snapshots: RunProgressSnapshot[] = []
  return { snapshots, onProgress: (s: RunProgressSnapshot) => snapshots.push(s) }
}

/** Per-call research stub: call n answers from script[n] (the last entry repeats). */
function scriptedProvider(script: ({ prose: string } | { fail: true })[]) {
  let call = 0
  return createStubProvider({
    async research() {
      const step = script[Math.min(call, script.length - 1)]!
      call += 1
      if ('fail' in step) throw new Error('research unavailable')
      return { prose: step.prose, sources: [{ title: 't', url: 'https://example.org/x' }] }
    },
  })
}

const SCHOOLS_PROSE = 'Hilo, HI schools are rated above the state average in the cited directory.'
const COFFEE_PROSE = 'Keaau, HI has a coffee shop on its main street, listed in the cited guide.'

describe('screen-first emission (the Hilo shape)', () => {
  it('emits at research start and at every pass boundary, verdicts filling in', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: HILO_SCREEN,
      rows: HILO_ROWS,
      geographyZctas: new Set(HILO_ROWS.map((r) => r.zcta)),
      researchQuery: STARBUCKS_QUESTION,
      queryText: STARBUCKS_QUESTION,
      provider: scriptedProvider([{ prose: SCHOOLS_PROSE }, { prose: COFFEE_PROSE }]),
      onProgress,
    })
    expect(answer.status).toBe('verified')
    expect(snapshots).toHaveLength(3)

    const [start, afterSchools, afterCoffee] = snapshots as [
      RunProgressSnapshot,
      RunProgressSnapshot,
      RunProgressSnapshot,
    ]
    // Research begins: the bar appears at 0 of the planned passes,
    // over the screen's fixed candidate set, every verdict pending.
    expect(start.doneUnits).toBe(0)
    expect(start.totalUnits).toBe(2)
    expect(progressPercent(start)).toBe(0)
    // The screen's own order (its ranking), not the fixture's.
    expect(start.places.map((p) => p.name)).toEqual(['Keaau, HI', 'Hilo, HI', 'Pahoa, HI'])
    for (const place of start.places) {
      expect(place.verdicts.every((v) => v.state === 'pending')).toBe(true)
    }
    // Pass 1 (schools): Hilo served, the others not-served; coffee
    // still pending everywhere.
    expect(afterSchools.doneUnits).toBe(1)
    expect(progressPercent(afterSchools)).toBe(50)
    expect(afterSchools.criteriaDone).toEqual(['School quality'])
    const hiloMid = afterSchools.places.find((p) => p.name === 'Hilo, HI')!
    expect(hiloMid.verdicts).toEqual([
      { criterion: 'School quality', state: 'served' },
      { criterion: 'Coffee nearby', state: 'pending' },
    ])
    const pahoaMid = afterSchools.places.find((p) => p.name === 'Pahoa, HI')!
    expect(pahoaMid.verdicts[0]).toEqual({ criterion: 'School quality', state: 'not-served' })
    // Pass 2 (coffee): Keaau served; the fraction completes.
    expect(afterCoffee.doneUnits).toBe(2)
    expect(progressPercent(afterCoffee)).toBe(100)
    expect(afterCoffee.criteriaDone).toEqual(['School quality', 'Coffee nearby'])
    const keaauEnd = afterCoffee.places.find((p) => p.name === 'Keaau, HI')!
    expect(keaauEnd.verdicts[1]).toEqual({ criterion: 'Coffee nearby', state: 'served' })
  })

  it('emits for a tolerated failed pass, its verdicts failed, the run still completing', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: HILO_SCREEN,
      rows: HILO_ROWS,
      geographyZctas: new Set(HILO_ROWS.map((r) => r.zcta)),
      researchQuery: STARBUCKS_QUESTION,
      queryText: STARBUCKS_QUESTION,
      provider: scriptedProvider([{ prose: SCHOOLS_PROSE }, { fail: true }]),
      onProgress,
    })
    expect(answer.status).toBe('verified')
    expect(snapshots).toHaveLength(3)
    const end = snapshots[2]!
    expect(end.doneUnits).toBe(2)
    expect(end.criteriaDone).toEqual(['School quality'])
    expect(end.criteriaFailed).toEqual(['Coffee nearby'])
    for (const place of end.places) {
      expect(place.verdicts[1]).toEqual({ criterion: 'Coffee nearby', state: 'failed' })
    }
  })

  it('a total failure still emits per pass and ends with every verdict failed', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: HILO_SCREEN,
      rows: HILO_ROWS,
      geographyZctas: new Set(HILO_ROWS.map((r) => r.zcta)),
      researchQuery: STARBUCKS_QUESTION,
      queryText: STARBUCKS_QUESTION,
      provider: scriptedProvider([{ fail: true }]),
      onProgress,
    })
    // The screen card carries the terminal (the A5 ladder); the
    // progress record closes with the failure stated, not vanished.
    // ADAPTED (Lane A9 FM-11): the all-empty stage is re-asked once,
    // so its two pass boundaries emit twice (5 snapshots, not 3);
    // the closing snapshot's content is the invariant guarded here.
    expect(answer.status).toBe('verified')
    expect(snapshots).toHaveLength(5)
    const end = snapshots[snapshots.length - 1]!
    expect(end.criteriaDone).toEqual([])
    expect(end.criteriaFailed).toEqual(['School quality', 'Coffee nearby'])
    for (const place of end.places) {
      expect(place.verdicts.every((v) => v.state === 'failed')).toBe(true)
    }
  })
})

const TX_ROWS: AreaRow[] = [
  { zcta: '79843', name: 'Marfa, TX', metrics: { median_gross_rent: 950 }, moes: { median_gross_rent: 120 } },
  { zcta: '73301', name: 'Austin, TX', metrics: { median_gross_rent: 1650 }, moes: { median_gross_rent: 60 } },
  { zcta: '79901', name: 'El Paso, TX', metrics: { median_gross_rent: 1100 }, moes: { median_gross_rent: 75 } },
]

const TX_INTENT: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['TX'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const TX_QUESTION = 'Where in Texas has the best schools and a Starbucks nearby?'

describe('research-first emission (the Texas shape)', () => {
  it('starts placeless and grows the candidate set from the accumulated prose', async () => {
    const { snapshots, onProgress } = collector()
    await runAnswerPipeline({
      intent: TX_INTENT,
      rows: TX_ROWS,
      researchQuery: TX_QUESTION,
      queryText: TX_QUESTION,
      provider: scriptedProvider([
        {
          prose:
            'Marfa, TX schools are rated highly in the cited directory. ' +
            'Austin, TX schools are also listed among the strongest.',
        },
        { prose: 'Marfa, TX has a beloved coffee shop on its main street.' },
      ]),
      onProgress,
    })
    expect(snapshots).toHaveLength(3)
    const [start, afterSchools, afterCoffee] = snapshots as [
      RunProgressSnapshot,
      RunProgressSnapshot,
      RunProgressSnapshot,
    ]
    expect(start.places).toEqual([])
    expect(start.doneUnits).toBe(0)
    expect(start.totalUnits).toBe(2)
    // The provisional set is what the prose so far names, resolved
    // through the terminal path's own seams.
    expect(afterSchools.places.map((p) => p.name)).toEqual(['Marfa, TX', 'Austin, TX'])
    expect(afterSchools.criteriaDone).toEqual(['School quality'])
    const marfaMid = afterSchools.places.find((p) => p.name === 'Marfa, TX')!
    expect(marfaMid.verdicts).toEqual([
      { criterion: 'School quality', state: 'served' },
      { criterion: 'Coffee nearby', state: 'pending' },
    ])
    const austinEnd = afterCoffee.places.find((p) => p.name === 'Austin, TX')!
    expect(austinEnd.verdicts[1]).toEqual({ criterion: 'Coffee nearby', state: 'not-served' })
    const marfaEnd = afterCoffee.places.find((p) => p.name === 'Marfa, TX')!
    expect(marfaEnd.verdicts[1]).toEqual({ criterion: 'Coffee nearby', state: 'served' })
  })

  it('a state-bounded total failure closes over the widened screen, all verdicts failed', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: TX_INTENT,
      rows: TX_ROWS,
      researchQuery: TX_QUESTION,
      queryText: TX_QUESTION,
      provider: scriptedProvider([{ fail: true }]),
      onProgress,
    })
    // The terminal itself is the pipeline's existing degrade
    // (A5's ladder); this pin's subject is the progress record:
    // TX is a state bound, so the failure degrades onto the state
    // screen and the record closes over its candidates.
    expect(answer.researchFailures).toEqual(['School quality', 'Coffee nearby'])
    expect(snapshots).toHaveLength(2)
    const end = snapshots[1]!
    expect(end.doneUnits).toBe(2)
    expect(end.criteriaDone).toEqual([])
    expect(end.criteriaFailed).toEqual(['School quality', 'Coffee nearby'])
    expect(end.places.length).toBeGreaterThan(0)
    for (const place of end.places) {
      expect(place.verdicts.every((v) => v.state === 'failed')).toBe(true)
    }
  })

  it('a placeless total failure ends with one all-failed, placeless snapshot', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: { ...TX_INTENT, geographies: [] },
      rows: TX_ROWS,
      researchQuery: TX_QUESTION,
      queryText: TX_QUESTION,
      provider: scriptedProvider([{ fail: true }]),
      onProgress,
    })
    expect(answer.researchFailures).toEqual(['School quality', 'Coffee nearby'])
    expect(snapshots).toHaveLength(2)
    const end = snapshots[1]!
    expect(end.places).toEqual([])
    expect(end.doneUnits).toBe(2)
    expect(end.criteriaDone).toEqual([])
    expect(end.criteriaFailed).toEqual(['School quality', 'Coffee nearby'])
  })
})

const COLORADO_Q = 'what city in Colorado has the best nature and the lowest cost of living?'

const CO_ROWS: AreaRow[] = [
  { zcta: '81090', name: 'Walsh, CO', metrics: { median_gross_rent: 283, median_home_value: 151100 }, moes: { median_gross_rent: 273, median_home_value: 71979 } },
  { zcta: '81301', name: 'Durango, CO', metrics: { median_gross_rent: 1500, median_home_value: 650000 }, moes: { median_gross_rent: 90, median_home_value: 30000 } },
  { zcta: '81611', name: 'Aspen, CO', metrics: { median_gross_rent: 2400, median_home_value: 2400000 }, moes: { median_gross_rent: 300, median_home_value: 200000 } },
]

describe('state-bounded total failure (the Colorado degrade)', () => {
  it('closes the progress record over the screen candidates, every verdict failed', async () => {
    const { snapshots, onProgress } = collector()
    await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
        filters: [],
        clarificationNeeded: false,
      },
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: scriptedProvider([{ fail: true }]),
      onProgress,
    })
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    const end = snapshots[snapshots.length - 1]!
    expect(end.criteriaDone).toEqual([])
    expect(end.criteriaFailed).toEqual(['Nature and outdoors'])
    expect(end.places.length).toBeGreaterThan(0)
    for (const place of end.places) {
      expect(place.verdicts).toEqual([{ criterion: 'Nature and outdoors', state: 'failed' }])
    }
  })
})

describe('shapes with no research', () => {
  it('emit nothing at all', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await runAnswerPipeline({
      intent: HILO_SCREEN,
      rows: HILO_ROWS,
      geographyZctas: new Set(HILO_ROWS.map((r) => r.zcta)),
      onProgress,
    })
    expect(answer.status).toBe('verified')
    expect(snapshots).toEqual([])
  })
})

describe('runner forwarding', () => {
  const PLACES: PlaceSuggestion[] = [
    { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720'] },
    { displayName: 'Keaau', censusName: 'Keaau CDP', state: 'HI', isCity: true, zips: ['96749'] },
    { displayName: 'Pahoa', censusName: 'Pahoa CDP', state: 'HI', isCity: true, zips: ['96778'] },
  ]
  const BY_ZIP = new Map<string, PlaceRecord>(
    PLACES.map(
      (place) =>
        [
          place.zips[0]!,
          {
            zip: place.zips[0]!,
            censusName: place.censusName,
            displayName: place.displayName,
            state: place.state,
            isCity: true,
            incorporated: true,
          },
        ] as const,
    ),
  )
  const INDEX = new PlaceIndex(BY_ZIP, PLACES)

  it('forwards the pipeline snapshots to the caller\u2019s onProgress', async () => {
    const { snapshots, onProgress } = collector()
    const answer = await composeAnswerForRequest({
      intent: {
        mode: 'sweep_filter',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1800 }],
        clarificationNeeded: false,
      },
      queryText: STARBUCKS_QUESTION,
      rows: HILO_ROWS,
      resolved: resolveAnswerGeographies(
        {
          mode: 'sweep_filter',
          geographies: [],
          metricKeys: ['median_gross_rent'],
          filters: [],
          clarificationNeeded: false,
        },
        INDEX,
      ),
      provider: scriptedProvider([{ prose: SCHOOLS_PROSE }, { prose: COFFEE_PROSE }]),
      research: true,
      stack: false,
      onProgress,
    })
    expect(answer?.status).toBe('verified')
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snapshots[0]!.doneUnits).toBe(0)
    const end = snapshots[snapshots.length - 1]!
    expect(end.doneUnits).toBe(end.totalUnits)
  })
})
