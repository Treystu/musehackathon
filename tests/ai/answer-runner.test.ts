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
  { displayName: 'Corbin', censusName: 'Corbin city', state: 'KY', isCity: true, zips: ['40771'] },
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

/**
 * Rows as production actually builds them: the ACS builder names
 * every sweep row with the Census NAME label, which for a ZCTA is
 * literally "ZCTA5 40771" — no human place name anywhere on the row.
 * The pre-existing ROWS above carry display names, which is why the
 * place-name defect (coordinator fixture render, 2026-11-02: the
 * AnswerCard headlined "ZCTA5 40771" instead of "Corbin, KY") never
 * showed in this suite.
 */
const ACS_ROWS: AreaRow[] = [
  {
    zcta: '40771',
    name: 'ZCTA5 40771',
    metrics: { median_gross_rent: 900 },
    moes: { median_gross_rent: 85 },
  },
  {
    zcta: '96720',
    name: 'ZCTA5 96720',
    metrics: { median_gross_rent: 1450 },
    moes: { median_gross_rent: 85 },
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

  it('screen-first: ACS-shaped rows are joined to place-index display names before the pipeline runs', async () => {
    let seenPlaces: string[] | undefined
    const provider = createStubProvider({
      async research(req) {
        seenPlaces = req.places
        return {
          prose:
            'Corbin, KY has two elementary schools within the district. ' +
            'Hilo, HI has two elementary schools within the district.',
          sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      queryText: 'places with schools where rent is under $1,500',
      rows: ACS_ROWS,
      resolved: resolveAnswerGeographies(intent({}), INDEX),
      provider,
      research: true,
      placeIndex: INDEX,
    })
    expect(answer?.status).toBe('verified')
    // The composed places — the names the AnswerCard headlines.
    expect(answer?.places.map((p) => p.name)).toEqual(['Corbin, KY', 'Hilo, HI'])
    // The research stage was told the proper names, not the ACS labels.
    expect(seenPlaces).toEqual(['Corbin, KY', 'Hilo, HI'])
    // Claim attribution matches by name mention: the claims naming
    // each place in prose landed on that place, not in generalClaims.
    expect(answer?.places.every((p) => p.claims.length > 0)).toBe(true)
    expect(answer?.generalClaims).toEqual([])
    // The loaded sweep itself is shared state: the join must not
    // rewrite the rows it was handed.
    expect(ACS_ROWS.map((r) => r.name)).toEqual(['ZCTA5 40771', 'ZCTA5 96720'])
  })

  it('research-first: pulled rows carry the place-index display name, not the ACS label', async () => {
    const answer = await composeAnswerForRequest({
      intent: intent({ mode: 'lookup', metricKeys: [] }),
      queryText: 'Which area has the best schools?',
      rows: ACS_ROWS,
      resolved: resolveAnswerGeographies(intent({}), INDEX),
      provider: createStubProvider({
        async research() {
          return {
            prose:
              'Corbin, KY elementary schools are rated above the state average in the cited directory.',
            sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
          }
        },
      }),
      research: true,
      placeIndex: INDEX,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Corbin, KY'])
    expect(answer?.places[0]?.claims.length).toBeGreaterThan(0)
  })

  it('a ZCTA with no place-index entry keeps its row name — no crash, no blank headline', async () => {
    const answer = await composeAnswerForRequest({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      queryText: 'places where rent is under $1,500',
      rows: [
        {
          zcta: '99999',
          name: 'ZCTA5 99999',
          metrics: { median_gross_rent: 800 },
          moes: { median_gross_rent: 50 },
        },
      ],
      resolved: resolveAnswerGeographies(intent({}), INDEX),
      provider: createStubProvider(),
      research: false,
      placeIndex: INDEX,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['ZCTA5 99999'])
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
