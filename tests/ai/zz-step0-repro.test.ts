import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decomposeResearchCriteria,
  hasUnclaimedCriterionPhrase,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import type { RunProgressSnapshot } from '../../src/core/ai/run-progress'
import { qualifyingPlacesMapRelevant, resultMapRelevant } from '../../src/core/map/result-scale'
import { decodePlaces } from '../../src/core/zcta-place-index'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'

/**
 * STEP 0 REPRO (temporary, not a pin): current behavior of the exact
 * owner question on 911b64c, hermetic only. Deleted after its
 * readings are recorded in the breadth seat's RESULTS.md.
 */

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return { mode: 'sweep_filter', geographies: [], metricKeys: [], filters: [], clarificationNeeded: false, ...partial }
}

function row(zcta: string, name: string, rent: number, pop: number): AreaRow {
  return { zcta, name, metrics: { median_gross_rent: rent, population: pop }, moes: { median_gross_rent: 60 } }
}

const TX_ROWS = [
  row('78701', 'Austin, TX', 1600, 950000), row('75201', 'Dallas, TX', 1400, 1300000),
  row('76102', 'Fort Worth, TX', 1250, 980000), row('77002', 'Houston, TX', 1350, 2300000),
  row('79901', 'El Paso, TX', 950, 680000), row('79101', 'Amarillo, TX', 900, 200000),
  row('78205', 'San Antonio, TX', 1100, 1430000), row('79401', 'Lubbock, TX', 925, 260000),
  row('79843', 'Marfa, TX', 1050, 1800), row('78839', 'Crystal City, TX', 700, 6700),
  row('78401', 'Corpus Christi, TX', 1150, 320000), row('76701', 'Waco, TX', 1000, 140000),
  row('79701', 'Midland, TX', 1300, 170000), row('75701', 'Tyler, TX', 975, 105000),
]

const PROSE = [
  'Austin, TX is widely described as the most liberal city in Texas.',
  'El Paso, TX is described as strongly Democratic and liberal-leaning.',
  'Crystal City, TX is described as a Democratic stronghold with liberal politics.',
  'Dallas, TX is often described as politically mixed.',
  'Houston, TX is described as politically mixed, with liberal and conservative areas.',
  'Fort Worth, TX is described as one of the most conservative large cities in Texas.',
  'Amarillo, TX is described as deeply conservative.',
  'Lubbock, TX is described as a conservative stronghold.',
].join(' ')

async function run(q: string) {
  const calls: { places: readonly string[]; queryText: string }[] = []
  const snapshots: RunProgressSnapshot[] = []
  const provider = createStubProvider({
    async research(input) {
      calls.push({ places: input.places, queryText: input.queryText })
      return { prose: PROSE, sources: [{ title: 'Findings source', url: 'https://example.com/f' }] }
    },
  })
  const answer: ComposedAnswer = await runAnswerPipeline({
    intent: intent({ geographies: ['Texas'] }),
    rows: TX_ROWS,
    researchQuery: q,
    researchCriteria: [q],
    queryText: q,
    provider,
    onProgress: (s) => snapshots.push(s),
  })
  return { answer, calls, snapshots }
}

describe('step 0 repro', () => {
  it('records the plural/set form', async () => {
    const q = 'Which areas of Texas are the most liberal?'
    const criteria = decomposeResearchCriteria(q)
    console.log('DECOMP', JSON.stringify(criteria.map((c) => ({ id: c.id, label: c.label }))))
    console.log('UNCLAIMED_PHRASE', hasUnclaimedCriterionPhrase(q, criteria))
    const { answer, calls, snapshots } = await run(q)
    console.log('CALLS', calls.length, JSON.stringify(calls.map((c) => c.places)))
    console.log('STATUS', answer.status, 'PLACES', answer.places.length, JSON.stringify(answer.places.map((p) => p.name)))
    console.log('CAP_APPLIED', answer.candidateCapApplied, 'NAMED', JSON.stringify(answer.researchNamedPlaces))
    console.log('CONSIDERED_NOT_MEETING', JSON.stringify(answer.consideredNotMeeting ?? null))
    console.log('SUMMARY', answer.summary)
    console.log('EVIDENCE', JSON.stringify(answer.criterionEvidence.map((e) => `${e.criterion}=${e.status}`)))
    console.log('QUALIFYING_MAP', qualifyingPlacesMapRelevant(answer), 'CHOROPLETH', resultMapRelevant(answer))
    console.log('SNAPSHOTS', snapshots.length, JSON.stringify(snapshots.map((s) => ({ done: s.doneUnits, total: s.totalUnits, places: s.places.length }))))
    expect(answer.status).toBe('verified')
  })

  it('records the singular form for contrast', async () => {
    const q = 'What is the most liberal city in Texas?'
    const { answer, calls, snapshots } = await run(q)
    console.log('SINGULAR CALLS', calls.length, 'PLACES', answer.places.length, JSON.stringify(answer.places.map((p) => p.name)))
    console.log('SINGULAR SNAPSHOTS', JSON.stringify(snapshots.map((s) => ({ done: s.doneUnits, total: s.totalUnits, places: s.places.length }))))
    expect(answer.status).toBe('verified')
  })

  it('counts the real Texas place universe in the shipped index', () => {
    const payload = JSON.parse(readFileSync('public/map/zcta-places.json', 'utf8'))
    const { byZip, places } = decodePlaces(payload)
    const txZips = [...byZip.values()].filter((r) => r.state === 'TX')
    const txPlaces = places.filter((p) => p.state === 'TX')
    const txCities = txPlaces.filter((p) => p.isCity)
    console.log('TX ZCTAS', txZips.length, 'TX DISTINCT PLACES', txPlaces.length, 'TX CITY PLACES', txCities.length, 'TX COUNTY FALLBACKS', txPlaces.length - txCities.length)
    expect(txZips.length).toBeGreaterThan(0)
  })
})
