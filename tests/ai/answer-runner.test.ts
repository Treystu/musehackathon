import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'
import {
  answerScopeCovered,
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'

/**
 * The UI adapter between the Ask flow and the answer pipeline:
 * geography resolution through the place index, sweep-scope coverage,
 * and the compose step over loaded rows (including the load-then-
 * compose sequence App's effect drives when rows are not yet in).
 */
const PLACES: PlaceSuggestion[] = [
  { displayName: 'Hilo', censusName: 'Hilo CDP', state: 'HI', isCity: true, zips: ['96720', '96721'] },
  { displayName: 'Keaau', censusName: 'Keaau CDP', state: 'HI', isCity: true, zips: ['96749'] },
  { displayName: 'Honolulu', censusName: 'Honolulu city', state: 'HI', isCity: true, zips: ['96813'] },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['73301'] },
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

const ROWS: AreaRow[] = [
  {
    zcta: '96720',
    name: 'Hilo, HI',
    metrics: { median_gross_rent: 1450 },
    moes: { median_gross_rent: 85 },
  },
  {
    zcta: '96749',
    name: 'Keaau, HI',
    metrics: { median_gross_rent: 1325 },
    moes: { median_gross_rent: 120 },
  },
  {
    zcta: '96778',
    name: 'Pahoa, HI',
    metrics: { median_gross_rent: 1750 },
    moes: { median_gross_rent: 150 },
  },
]

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

describe('resolveAnswerGeographies', () => {
  it('lookup keeps one ZIP per named place, the same rule executeIntent opens', () => {
    const resolved = resolveAnswerGeographies(
      intent({ mode: 'lookup', geographies: ['Hilo'] }),
      INDEX,
    )
    expect([...resolved.zctas]).toEqual(['96720'])
    expect(resolved.scopePrefixes).toEqual(['96'])
    expect(resolved.unresolvable).toBe(false)
  })

  it('a sweep resolves the whole named state and the whole named city', () => {
    const byState = resolveAnswerGeographies(intent({ geographies: ['HI'] }), INDEX)
    expect([...byState.zctas].sort()).toEqual(['96720', '96721', '96749', '96813'])
    const byCity = resolveAnswerGeographies(intent({ geographies: ['Hilo'] }), INDEX)
    expect([...byCity.zctas].sort()).toEqual(['96720', '96721'])
  })

  it('a 5-digit geography is its own ZCTA and needs no index', () => {
    const resolved = resolveAnswerGeographies(intent({ geographies: ['96720'] }), null)
    expect([...resolved.zctas]).toEqual(['96720'])
    expect(resolved.unresolvable).toBe(false)
  })

  it('an unresolvable geography is reported, never guessed', () => {
    const resolved = resolveAnswerGeographies(intent({ geographies: ['Atlantis'] }), INDEX)
    expect(resolved.zctas.size).toBe(0)
    expect(resolved.unresolvable).toBe(true)
  })
})

describe('answerScopeCovered', () => {
  const resolved = resolveAnswerGeographies(intent({ geographies: ['HI'] }), INDEX)
  it('no rows is never covered; a national load covers any geography', () => {
    expect(
      answerScopeCovered({ rowCount: 0, sweepScope: [], resolved, placeless: false }),
    ).toBe(false)
    expect(
      answerScopeCovered({ rowCount: 100, sweepScope: [], resolved, placeless: false }),
    ).toBe(true)
  })

  it('a state-scoped load covers its own prefixes and no others', () => {
    expect(
      answerScopeCovered({ rowCount: 100, sweepScope: ['96'], resolved, placeless: false }),
    ).toBe(true)
    const texas = resolveAnswerGeographies(intent({ geographies: ['Austin'] }), INDEX)
    expect(
      answerScopeCovered({ rowCount: 100, sweepScope: ['96'], resolved: texas, placeless: false }),
    ).toBe(false)
  })

  it('a placeless question needs the national load, not a state-scoped leftover', () => {
    const placeless = resolveAnswerGeographies(intent({}), INDEX)
    expect(
      answerScopeCovered({ rowCount: 100, sweepScope: ['96'], resolved: placeless, placeless: true }),
    ).toBe(false)
    expect(
      answerScopeCovered({ rowCount: 100, sweepScope: [], resolved: placeless, placeless: true }),
    ).toBe(true)
  })
})

describe('composeAnswerForRequest', () => {
  it('composes a verified answer over the loaded rows once they cover the geography', async () => {
    // The sequence App's effect drives: rows start absent (coverage
    // false, a scope load is triggered), then the loaded rows arrive
    // and the same request composes.
    const resolved = resolveAnswerGeographies(intent({ geographies: ['HI'] }), INDEX)
    expect(
      answerScopeCovered({ rowCount: 0, sweepScope: [], resolved, placeless: false }),
    ).toBe(false)
    const answer = await composeAnswerForRequest({
      intent: intent({
        geographies: ['HI'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
      }),
      queryText: 'places in Hawaii where rent is under $1,500',
      rows: ROWS,
      resolved,
      provider: createStubProvider(),
      research: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Keaau, HI'])
  })

  it('research runs over only the screened subset, with the original question text', async () => {
    let seenQuery: string | undefined
    let seenPlaces: string[] | undefined
    const provider = createStubProvider({
      async research(req) {
        seenQuery = req.queryText
        seenPlaces = req.places
        return {
          prose: 'Hilo, HI has two elementary schools within the district.',
          sources: [{ title: 'Hawaii DOE', url: 'https://example.org/doe' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      queryText: 'places with schools where rent is under $1,500',
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), INDEX),
      provider,
      research: true,
    })
    expect(answer?.status).toBe('verified')
    expect(seenQuery).toBe('places with schools where rent is under $1,500')
    expect(seenPlaces).toEqual(['Hilo, HI', 'Keaau, HI'])
  })

  it('returns null when no named geography resolved', async () => {
    const answer = await composeAnswerForRequest({
      intent: intent({ geographies: ['Atlantis'] }),
      queryText: 'rent in Atlantis',
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({ geographies: ['Atlantis'] }), INDEX),
      provider: createStubProvider(),
      research: false,
    })
    expect(answer).toBeNull()
  })
})
