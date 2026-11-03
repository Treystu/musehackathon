// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  SCREENED_RESEARCH_CANDIDATE_CAP,
  decomposeResearchCriteria,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import { rescueNationalScreen } from '../../src/core/ai/national-screen'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { PlaceIndex, type PlaceRecord, type PlaceSuggestion } from '../../src/core/zcta-place-index'

/**
 * Answer Layer generalization (2026-11-02, owner directive):
 * arbitrary multi-criteria cross-referenced questions. Every case
 * runs the real pipeline and renders the real card, hermetic at the
 * provider seams (canned research / extraction), over fixture rows.
 */

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
  {
    zcta: '78520',
    name: 'Brownsville, TX',
    metrics: { median_gross_rent: 950 },
    moes: { median_gross_rent: 60 },
  },
  {
    zcta: '73301',
    name: 'Austin, TX',
    metrics: { median_gross_rent: 1800 },
    moes: { median_gross_rent: 110 },
  },
  {
    zcta: '75034',
    name: 'Frisco, TX',
    metrics: { median_gross_rent: 2100 },
    moes: { median_gross_rent: 140 },
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

function cardText(answer: ComposedAnswer): string {
  render(<AnswerCard answer={answer} />)
  return container.textContent ?? ''
}

/* ------------------------------------------------------------------ */
/* (ii) research-first: best schools + fewest fast food                */
/* ------------------------------------------------------------------ */

const RESEARCH_FIRST_QUESTION =
  'Which area has the best schools and the fewest fast food restaurants?'

function researchFirstProvider() {
  return createStubProvider({
    async research() {
      return {
        prose:
          'Hilo, HI elementary schools are rated above the state average in the cited directory. ' +
          'Hilo, HI has few fast-food outlets along its main street. ' +
          'Nowhereville, ZZ was mentioned in passing by one listing.',
        sources: [
          { title: 'State school directory', url: 'https://example.org/schools' },
          { title: 'Local dining guide', url: 'https://example.org/dining' },
        ],
      }
    },
  })
}

describe('(ii) research-first: only external criteria', () => {
  it('decomposes into two researched criteria, carried separately', () => {
    const criteria = decomposeResearchCriteria(RESEARCH_FIRST_QUESTION)
    expect(criteria.map((c) => c.id)).toEqual(['schools', 'fast_food'])
    expect(criteria.find((c) => c.id === 'fast_food')?.quantitative).toBe(true)
    expect(criteria.find((c) => c.id === 'schools')?.quantitative).toBe(false)
  })

  it('research -> extraction -> resolution -> figure pull -> card naming the joint answer with per-criterion evidence', async () => {
    const answer = await runAnswerPipeline({
      // The parse can carry no Census criterion for this question:
      // no bound, no measure — only the external criteria.
      intent: intent({ metricKeys: [] }),
      rows: ROWS,
      researchQuery: RESEARCH_FIRST_QUESTION,
      provider: researchFirstProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'fast_food'])
    // Only Hilo was named by the cited findings and resolved; the
    // invented listing name resolved to nothing and is reported.
    expect(answer.places.map((p) => p.name)).toEqual(['Hilo, HI'])
    expect(answer.unresolvedCandidates).toEqual(['Nowhereville, ZZ'])
    // Pull mode attached the headline Census figure for the candidate.
    expect(answer.places[0]?.figures).toEqual([
      { key: 'median_gross_rent', value: 1450, marginOfError: 85 },
    ])
    // Per-criterion evidence: schools served by a cited source;
    // fast food is count-seeking and the cited source is qualitative,
    // so it is partially measured — never upgraded to a count.
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('met')
    expect(schools?.sourceUrls).toContain('https://example.org/schools')
    const fastFood = answer.criterionEvidence.find((e) => e.criterion === 'Fast food restaurants')
    expect(fastFood?.status).toBe('partially_measured')

    const text = cardText(answer)
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('$1,450/mo')
    expect(text).toContain('School quality')
    expect(text).toContain('measured')
    expect(text).toContain('Fast food restaurants')
    expect(text).toContain('partially measured')
    // The qualitative wording stays qualitative on the card.
    expect(text).toContain('Hilo, HI has few fast-food outlets along its main street.')
    expect(text).toContain(
      'Research named Nowhereville, ZZ, which could not be matched to Census data, so it was not used.',
    )
  })

  it('unresolvable candidate names are dropped and counted, never guessed (injected extraction seam)', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ metricKeys: [] }),
      rows: ROWS,
      researchQuery: RESEARCH_FIRST_QUESTION,
      provider: researchFirstProvider(),
      // The canned extraction seam: names the prose never carried in
      // resolvable form, to prove extraction output is validated.
      candidateExtractor: () => ['Hilo, HI', 'Atlantis, ZZ'],
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toEqual(['Hilo, HI'])
    // ADAPTED (Lane A9 FM-5, then Lane A10 FM-14): the provider's
    // prose also names Nowhereville bare, as a sentence subject.
    // FM-5 recorded such mentions with the unresolved names so
    // they could not vanish; FM-14's extraction-precision gate
    // records a no-row bare mention as a NAME only when the loaded
    // place index can test it as place-shaped (a component word of
    // a real place name) — this fixture's rows cannot test
    // "Nowhereville", so the mention is counted as a fragment on
    // the answer instead of printed as a name. The invariant this
    // pin guards — unresolvable names are dropped and counted,
    // never guessed — is unchanged: places still holds Hilo alone,
    // and the mention is accounted, not silent.
    expect(answer.unresolvedCandidates).toEqual(['Atlantis, ZZ'])
    expect(answer.unmatchedFragmentCount).toBe(1)
  })

  it('partial evidence stays labelled partial and is never silently upgraded', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ metricKeys: [] }),
      rows: ROWS,
      researchQuery: RESEARCH_FIRST_QUESTION,
      provider: researchFirstProvider(),
    })
    const fastFood = answer.criterionEvidence.find((e) => e.criterion === 'Fast food restaurants')
    expect(fastFood?.status).toBe('partially_measured')
    expect(fastFood?.detail).toContain('qualitative terms only, so no count is shown')
    const text = cardText(answer)
    expect(text).toContain('partially measured')
    // No count for fast food appears anywhere on the card.
    expect(text).not.toMatch(/\d+\s+fast-food/)
  })
})

/* ------------------------------------------------------------------ */
/* (iii) screen-first: schools + affordable + a Starbucks nearby       */
/* ------------------------------------------------------------------ */

describe('(iii) screen-then-research: affordability screen first, research over survivors only', () => {
  it('screens by rent, researches only the survivors, and the card leads with the joint answer', async () => {
    const researchedPlacesPerCall: string[][] = []
    const provider = createStubProvider({
      async research(req) {
        researchedPlacesPerCall.push([...(req.places ?? [])])
        return {
          prose:
            'Hilo, HI has two elementary schools within the district. ' +
            'A Starbucks is located in Keaau, HI.',
          sources: [
            { title: 'State school directory', url: 'https://example.org/schools' },
            { title: 'Store locator', url: 'https://example.org/starbucks' },
          ],
        }
      },
    })
    const question = 'Where has good schools and affordable housing with a Starbucks nearby?'
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] }),
      // The Hawaii rows only: this case is the Waiakea-corridor shape
      // (2026-11-01 live proof) — a Hawaii question over Hawaii rows.
      rows: ROWS.slice(0, 3),
      researchQuery: question,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'coffee'])
    // The Census screen ran first: Pahoa (rent 1750) never reached
    // research, in any criterion's pass.
    expect(researchedPlacesPerCall.length).toBeGreaterThan(0)
    for (const places of researchedPlacesPerCall) {
      expect(places).toEqual(['Hilo, HI', 'Keaau, HI'])
    }
    expect(answer.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Keaau, HI'])
    const census = answer.criterionEvidence.find((e) => e.kind === 'census')
    expect(census?.status).toBe('met')
    expect(answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status).toBe('met')
    expect(answer.criterionEvidence.find((e) => e.criterion === 'Coffee nearby')?.status).toBe('met')

    const text = cardText(answer)
    // The card leads with the cheapest survivor, then the researched claims.
    expect(text.indexOf('Keaau, HI')).toBeLessThan(text.indexOf('Hilo, HI'))
    expect(text).toContain('A Starbucks is located in Keaau, HI.')
    expect(text).toContain('Hilo, HI has two elementary schools within the district.')
    expect(text).not.toContain('Pahoa, HI')
  })

  it('carries outside criteria the catalog cannot separate as one combined criterion', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ mode: 'lookup', geographies: ['96720'] }),
      rows: ROWS,
      researchQuery: 'What is the general character of this area?',
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Hilo, HI hosts a weekly farmers market downtown.',
            sources: [{ title: 'Market guide', url: 'https://example.org/market' }],
          }
        },
      }),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchCriteria).toHaveLength(1)
    expect(answer.researchCriteria[0]?.id).toBe('combined')
  })
})

/* ------------------------------------------------------------------ */
/* Cap disclosure                                                      */
/* ------------------------------------------------------------------ */

describe('candidate cap disclosure', () => {
  it('caps the research pass at the named constant and the answer + card disclose it', async () => {
    const manyRows: AreaRow[] = Array.from({ length: 12 }, (_, i) => ({
      zcta: `967${String(10 + i)}`,
      name: `Place ${i + 1}, HI`,
      metrics: { median_gross_rent: 1000 + i * 10 },
      moes: { median_gross_rent: 50 },
    }))
    let researchedPlaces: string[] = []
    const provider = createStubProvider({
      async research(req) {
        researchedPlaces = [...(req.places ?? [])]
        return {
          prose: 'A public library branch serves the area.',
          sources: [{ title: 'Library system', url: 'https://example.org/library' }],
        }
      },
    })
    const answer = await runAnswerPipeline({
      intent: intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }] }),
      rows: manyRows,
      researchQuery: 'places under the rent bound with schools nearby',
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.candidateCap).toBe(SCREENED_RESEARCH_CANDIDATE_CAP)
    expect(answer.candidateCapApplied).toBe(true)
    expect(researchedPlaces).toHaveLength(SCREENED_RESEARCH_CANDIDATE_CAP)
    const text = cardText(answer)
    expect(text).toContain(
      `Research covered the first ${SCREENED_RESEARCH_CANDIDATE_CAP} candidate places; any further places were not researched.`,
    )
  })
})

/* ------------------------------------------------------------------ */
/* (iv) county level + bounded superlative                             */
/* ------------------------------------------------------------------ */

const TX_INDEX_PLACES: PlaceSuggestion[] = [
  { displayName: 'Brownsville', censusName: 'Brownsville city', state: 'TX', isCity: true, zips: ['78520'] },
  { displayName: 'Austin', censusName: 'Austin city', state: 'TX', isCity: true, zips: ['73301'] },
  { displayName: 'Frisco', censusName: 'Frisco city', state: 'TX', isCity: true, zips: ['75034'] },
]
const TX_INDEX = new PlaceIndex(
  new Map<string, PlaceRecord>(
    TX_INDEX_PLACES.flatMap((place) =>
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
  TX_INDEX_PLACES,
)

describe('(iv) county-level question: the named gap, asserted in the honesty reporting', () => {
  it('a county question is answered at place level with the county gap disclosed, never as a county rollup', async () => {
    const rescued = rescueNationalScreen(
      {
        mode: 'lookup',
        geographies: ['Texas'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: true,
      },
      'Which county in Texas has the lowest rent?',
    )
    expect(rescued).not.toBeNull()
    const answer = await composeAnswerForRequest({
      intent: rescued!,
      queryText: 'Which county in Texas has the lowest rent?',
      rows: ROWS,
      resolved: resolveAnswerGeographies(rescued!, TX_INDEX),
      provider: createStubProvider(),
      research: false,
    })
    expect(answer?.status).toBe('verified')
    // The bounded screen ran over Texas places, cheapest first.
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Brownsville, TX',
      'Austin, TX',
      'Frisco, TX',
    ])
    // The county level is reported as the gap it is (see the
    // AnswerGeographyLevel finding in answer.ts): requested level
    // named, support denied, evidence entry not_measurable.
    expect(answer?.geographyLevel).toBe('county')
    expect(answer?.unsupportedGeography).toBe('county')
    const countyEvidence = answer?.criterionEvidence.find(
      (e) => e.criterion === 'County-level geography',
    )
    expect(countyEvidence?.status).toBe('not_measurable')
    const text = cardText(answer!)
    expect(text).toContain('Brownsville, TX')
    expect(text).toContain('$950/mo')
    expect(text).toContain(
      'County-level figures are not available from the shipped data, so the places shown are at place and ZIP level.',
    )
  })
})

describe('bounded superlative: cheapest place to live in Texas, end to end', () => {
  it('parse clarification -> bounded rescue -> verified card naming the cheapest Texas place', async () => {
    const onExecute = vi.fn()
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Texas'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } satisfies ValidatedIntent,
        }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    const input = container.querySelector('#ask-input') as HTMLInputElement
    const form = container.querySelector('form') as HTMLFormElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('input value setter unavailable')
    act(() => {
      setter.call(input, 'cheapest place to live in Texas')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    // No clarification: the bounded screen ran and disclosed itself.
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    expect(container.textContent).toContain(
      'This screens Texas by median gross rent, lowest first.',
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    const bounded = onExecute.mock.calls[0]?.[0] as ValidatedIntent
    expect(bounded).toMatchObject({
      mode: 'sweep_filter',
      geographies: ['Texas'],
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })
    expect(requests).toHaveLength(1)

    const answer = await composeAnswerForRequest({
      intent: bounded,
      queryText: 'cheapest place to live in Texas',
      rows: ROWS,
      resolved: resolveAnswerGeographies(bounded, TX_INDEX),
      provider: createStubProvider(),
      research: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.unsupportedGeography).toBeNull()
    const text = cardText(answer!)
    expect(text).toContain('Brownsville, TX')
    expect(text).toContain('$950/mo')
    expect(text.indexOf('Brownsville, TX')).toBeLessThan(text.indexOf('Austin, TX'))
    // No Hawaii place leaks into a Texas-bounded answer.
    expect(text).not.toContain('Hilo, HI')
  })

  it('a cost superlative with an unresolvable geography stays a clarification', () => {
    expect(
      rescueNationalScreen(
        {
          mode: 'lookup',
          geographies: ['Springfield'],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
        'cheapest place to live in Springfield',
      ),
    ).toBeNull()
    // And the no-criteria shape still clarifies: "best place to
    // raise a family" carries no cost superlative and no criteria.
    expect(
      rescueNationalScreen(
        {
          mode: 'lookup',
          geographies: ['Texas'],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
        'best place to raise a family in Texas',
      ),
    ).toBeNull()
  })
})
