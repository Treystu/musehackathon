import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { runAnswerPipeline, SCREENED_RESEARCH_CANDIDATE_CAP } from '../../src/core/ai/answer'
import {
  createLiveProvider,
  ProviderCallError,
  RESEARCH_PLACES_LIMIT,
} from '../../src/core/ai/meta-client'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { handleResearch } from '../../functions/api/muse/research'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import type { MuseProvider } from '../../src/core/ai/provider'

/**
 * The research places seam (2026-11-02, owner live failures 18:03
 * and 23:42 HST): the pipeline's screened-research stage sends up
 * to SCREENED_RESEARCH_CANDIDATE_CAP (10) place names per research
 * pass, while the research route's own shape validation refused
 * more than 8 — so every screen returning 9-10 rows had its
 * research pass refused with a 400 before any upstream call, and
 * the card recorded the criterion as a lookup that "did not
 * return", while narrower screens and placeless research-first
 * questions worked. Verified against the live route that night:
 * the Nashville question with 10 places -> 400 shape_invalid in
 * ~1s; with 8 places -> 200; with none -> 200; the Hilo Starbucks
 * question at 10 places -> the same 400.
 *
 * The cure is one shared constant (RESEARCH_PLACES_LIMIT): the
 * route validates against it and both providers slice to it. These
 * pins hold the contract at each side of the seam and at the
 * pipeline above it: a stub provider here ENFORCES the route's
 * shape rule from the same constant, so a future divergence
 * between the cap and the limit fails these tests instead of a
 * live card.
 */

const NASHVILLE_QUESTION =
  "Where can I move around Nashville that's got good schools and high wages"
const STARBUCKS_QUESTION =
  'Where in Hilo has the best schools and affordable housing, with a Starbucks nearby?'

const NASHVILLE_ROWS: AreaRow[] = [
  { zcta: '37027', name: 'Brentwood, TN', metrics: { median_household_income: 165000 }, moes: { median_household_income: 8200 } },
  { zcta: '37064', name: 'Franklin, TN', metrics: { median_household_income: 142000 }, moes: { median_household_income: 7600 } },
  { zcta: '37075', name: 'Hendersonville, TN', metrics: { median_household_income: 98000 }, moes: { median_household_income: 6100 } },
  { zcta: '37066', name: 'Gallatin, TN', metrics: { median_household_income: 89000 }, moes: { median_household_income: 5800 } },
  { zcta: '37129', name: 'Murfreesboro, TN', metrics: { median_household_income: 87000 }, moes: { median_household_income: 5400 } },
  { zcta: '37122', name: 'Mount Juliet, TN', metrics: { median_household_income: 112000 }, moes: { median_household_income: 6900 } },
  { zcta: '37135', name: 'Nolensville, TN', metrics: { median_household_income: 138000 }, moes: { median_household_income: 7100 } },
  { zcta: '37174', name: 'Spring Hill, TN', metrics: { median_household_income: 108000 }, moes: { median_household_income: 6300 } },
  { zcta: '37087', name: 'Lebanon, TN', metrics: { median_household_income: 76000 }, moes: { median_household_income: 4900 } },
  { zcta: '37210', name: 'Nashville-Davidson, TN', metrics: { median_household_income: 72000 }, moes: { median_household_income: 3800 } },
]

const NASHVILLE_SCREEN: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Nashville'],
  metricKeys: ['median_household_income'],
  filters: [],
  clarificationNeeded: false,
}

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

/**
 * A provider stub that enforces the research route's shape rule
 * from the shared constant, exactly as handleResearch does: more
 * places than the limit is a shape refusal before any findings.
 */
function routeShapedProvider(
  handler: (req: { queryText: string; places?: string[] }) => Promise<{
    prose: string
    sources: { title: string; url: string }[]
  }>,
  received: string[][],
) {
  return createStubProvider({
    research: async (req) => {
      const places = [...(req.places ?? [])]
      received.push(places)
      if (places.length > RESEARCH_PLACES_LIMIT) {
        throw new ProviderCallError('shape_invalid')
      }
      return handler(req)
    },
  })
}

describe('the shared places limit', () => {
  it('the pipeline cap never exceeds the route limit', () => {
    expect(SCREENED_RESEARCH_CANDIDATE_CAP).toBeLessThanOrEqual(RESEARCH_PLACES_LIMIT)
  })

  it('the route accepts a full capped request and refuses one above it', async () => {
    const seen: string[][] = []
    const deps = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider({
        research: async (req) => {
          seen.push([...(req.places ?? [])])
          return {
            prose: 'Brentwood schools are listed in the cited directory.',
            sources: [{ title: 'TN school directory', url: 'https://example.org/tn-schools' }],
          }
        },
      }) as MuseProvider,
      allowedModels: ['spark-test'],
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
    }
    const ten = NASHVILLE_ROWS.map((r) => r.name)
    const ok = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: NASHVILLE_QUESTION, places: ten }, clientId: 'c1' },
      deps,
    )
    expect(ok.status).toBe(200)
    expect(seen[0]).toHaveLength(RESEARCH_PLACES_LIMIT)

    const eleven = [...ten, 'Extra, TN']
    const refused = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: NASHVILLE_QUESTION, places: eleven }, clientId: 'c1' },
      deps,
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('shape_invalid')
    expect(seen).toHaveLength(1)
  })

  it('the live provider slices an over-limit request to the limit instead of sending it', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(
        JSON.stringify({
          prose: 'Brentwood schools are listed in the cited directory.',
          sources: [{ title: 'TN school directory', url: 'https://example.org/tn-schools' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const provider = createLiveProvider({ fetchImpl })
    const twelve = [...NASHVILLE_ROWS.map((r) => r.name), 'Extra, TN', 'Other, TN']
    const result = await provider.research(
      { queryText: NASHVILLE_QUESTION, places: twelve },
      new AbortController().signal,
    )
    expect(result.sources).toHaveLength(1)
    expect(bodies).toHaveLength(1)
    expect((bodies[0] as { places: string[] }).places).toEqual(twelve.slice(0, RESEARCH_PLACES_LIMIT))
  })
})

describe('Nashville: schools + high wages over a full screen', () => {
  it('the schools criterion is cited alongside the income rows', async () => {
    const received: string[][] = []
    const provider = routeShapedProvider(
      async () => ({
        prose:
          'Brentwood, TN schools are rated above the Tennessee average in the cited school directory. ' +
          'Franklin, TN schools are rated above the Tennessee average in the cited school directory.',
        sources: [{ title: 'TN school directory', url: 'https://example.org/tn-schools' }],
      }),
      received,
    )
    const answer = await runAnswerPipeline({
      intent: NASHVILLE_SCREEN,
      rows: NASHVILLE_ROWS,
      geographyZctas: new Set(NASHVILLE_ROWS.map((r) => r.zcta)),
      researchQuery: NASHVILLE_QUESTION,
      queryText: NASHVILLE_QUESTION,
      provider,
    })
    expect(answer.status).toBe('verified')
    // The full capped subset went out as one conforming request.
    expect(received).toHaveLength(1)
    expect(received[0]).toHaveLength(SCREENED_RESEARCH_CANDIDATE_CAP)
    expect(answer.researchFailures ?? []).toEqual([])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    expect(schools?.sourceUrls).toContain('https://example.org/tn-schools')
    // The Census half of the question: every shown place carries
    // the income figure the wages criterion decomposed to.
    expect(answer.places.length).toBeGreaterThan(0)
    for (const place of answer.places) {
      expect(place.figures.some((f) => f.key === 'median_household_income')).toBe(true)
    }
  })

  it('a failed schools lookup still composes, stamped on its own line', async () => {
    const received: string[][] = []
    const provider = routeShapedProvider(async () => {
      throw new Error('provider_down')
    }, received)
    const answer = await runAnswerPipeline({
      intent: NASHVILLE_SCREEN,
      rows: NASHVILLE_ROWS,
      geographyZctas: new Set(NASHVILLE_ROWS.map((r) => r.zcta)),
      researchQuery: NASHVILLE_QUESTION,
      queryText: NASHVILLE_QUESTION,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchFailures).toEqual(['School quality'])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('not_measurable')
    expect(schools?.detail).toContain('did not return')
    for (const place of answer.places) {
      expect(place.figures.some((f) => f.key === 'median_household_income')).toBe(true)
    }
  })
})

describe('Hilo: schools + affordable housing + a Starbucks nearby', () => {
  it('the coffee criterion is cited, not dropped, beside schools', async () => {
    const received: string[][] = []
    const provider = routeShapedProvider(
      async () => ({
        prose:
          'Hilo, HI schools are rated above the state average in the cited directory. ' +
          'A Starbucks coffee shop operates in Hilo, per the cited store listing.',
        sources: [
          { title: 'HI school directory', url: 'https://example.org/hi-schools' },
          { title: 'Store listing', url: 'https://example.org/hilo-starbucks' },
        ],
      }),
      received,
    )
    const answer = await runAnswerPipeline({
      intent: HILO_SCREEN,
      rows: HILO_ROWS,
      geographyZctas: new Set(HILO_ROWS.map((r) => r.zcta)),
      researchQuery: STARBUCKS_QUESTION,
      queryText: STARBUCKS_QUESTION,
      provider,
    })
    expect(answer.status).toBe('verified')
    // One pass per researched criterion (schools, coffee).
    expect(received.length).toBe(2)
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    const coffee = answer.criterionEvidence.find((e) => e.criterion === 'Coffee nearby')
    expect(coffee?.status).toBe('met')
    expect(coffee?.sourceUrls.length).toBeGreaterThan(0)
  })
})
