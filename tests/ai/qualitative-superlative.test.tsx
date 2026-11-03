// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decomposeResearchCriteria,
  filterWorkingNarration,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { resultMapRelevant } from '../../src/core/map/result-scale'
import { AnswerCard, claimSourceVisibility } from '../../src/ui/ai/AnswerCard'

/**
 * Qualitative-superlative presentation cure (owner live failure,
 * 2026-11-03, production 0460cfd, owner device: "what city in Texas
 * is the most liberal" answered as a whole-state rent sort — the
 * research's working narration rendered verbatim, one source-title
 * list repeated after every claim, the conclusion buried under
 * towns the research itself called strongly conservative, and a
 * median-rent choropleth over 25 of 1,990 places). The pins:
 *  - the specimen, named: the class routes research-first, the
 *    card leads with the research-named shortlist in research
 *    order, pulled figures are labelled context in the summary,
 *    no narration renders, each source renders once, no map.
 *  - prose hygiene as a unit: every leaked string class drops at
 *    the composition boundary; the conclusion survives
 *    de-scaffolded.
 *  - the all-conditions battery the owner directed: criterion
 *    class (Census-only / researched-only / mixed) x question
 *    shape (superlative / bounded screen / lookup) x geography
 *    (state-bounded / placeless / named-place), each cell with a
 *    defined terminal, answer shape, narration check, and map
 *    relevance.
 */

const NARRATION_SENTENCE = "I'll check the remaining towns next."
const LEAKED_STRINGS = [
  NARRATION_SENTENCE,
  "I've mapped the political leanings across all ten places.",
  "Now I'll gather supporting context on the top liberal contenders.",
  'Marfa and Crystal City show liberal leanings so far.',
  'Research covered the first 10 candidate places; any further places were not researched.',
  'Marfa, TX Political Map | Democrat & Republican Areas in Marfa Zip 79843',
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

function providerReturning(prose: string, calls?: { places: readonly string[] }[]) {
  return createStubProvider({
    async research(input) {
      calls?.push({ places: input.places })
      return { prose, sources: [{ title: 'Source', url: 'https://example.com/s' }] }
    },
  })
}

function allRenderedText(answer: ComposedAnswer): string {
  return [
    answer.summary,
    ...answer.places.flatMap((p) => p.claims.map((c) => c.text)),
    ...answer.generalClaims.map((c) => c.text),
  ].join('\n')
}

function expectNoNarration(answer: ComposedAnswer) {
  const rendered = allRenderedText(answer)
  for (const leaked of LEAKED_STRINGS) expect(rendered).not.toContain(leaked)
  expect(rendered).not.toContain('**')
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const TEXAS_Q = 'what city in Texas is the most liberal'
const MARFA_TITLE = 'Marfa, TX Political Map | Democrat & Republican Areas in Marfa Zip 79843'

const TX_ROWS: AreaRow[] = [
  { zcta: '78151', name: 'Runge, TX', metrics: { median_gross_rent: 322 }, moes: { median_gross_rent: 311 } },
  { zcta: '79248', name: 'Paducah, TX', metrics: { median_gross_rent: 323 }, moes: { median_gross_rent: 154 } },
  { zcta: '79532', name: 'Loraine, TX', metrics: { median_gross_rent: 367 }, moes: { median_gross_rent: 72 } },
  { zcta: '78594', name: 'Sebastian, TX', metrics: { median_gross_rent: 369 }, moes: { median_gross_rent: 304 } },
  { zcta: '79733', name: 'Forsan, TX', metrics: { median_gross_rent: 382 }, moes: { median_gross_rent: 78 } },
  { zcta: '78827', name: 'Asherton, TX', metrics: { median_gross_rent: 440 }, moes: { median_gross_rent: 242 } },
  { zcta: '75449', name: 'Ladonia, TX', metrics: { median_gross_rent: 443 }, moes: { median_gross_rent: 401 } },
  { zcta: '78839', name: 'Crystal City, TX', metrics: { median_gross_rent: 448 }, moes: { median_gross_rent: 180 } },
  { zcta: '79843', name: 'Marfa, TX', metrics: { median_gross_rent: 460 }, moes: { median_gross_rent: 79 } },
  { zcta: '76265', name: 'St. Jo, TX', metrics: { median_gross_rent: 468 }, moes: { median_gross_rent: 94 } },
  { zcta: '79901', name: 'El Paso, TX', metrics: { median_gross_rent: 850 }, moes: { median_gross_rent: 40 } },
  { zcta: '78701', name: 'Austin, TX', metrics: { median_gross_rent: 1200 }, moes: { median_gross_rent: 50 } },
]

/**
 * Research prose answering the question directly (the research-
 * first call's shape), carrying the specimen's content classes:
 * per-place findings, a markdown header line, working narration,
 * a raw source title inside a sentence, and the scaffolded
 * conclusion.
 */
const TEXAS_PROSE =
  '**What sources say about political character — liberal:**\n' +
  'Crystal City, TX is described as strongly liberal and is called the bluest town in red Texas. ' +
  'Marfa, TX is described as moderately liberal and runs about 14 points more Democratic than Texas as a whole. ' +
  'Asherton, TX is described as moderately liberal, a true toss-up at about 52 percent Democratic. ' +
  'Sebastian, TX is described as somewhat liberal, though another reading of the same county leans slightly Republican. ' +
  "I'll check the remaining towns next. " +
  "I've mapped the political leanings across all ten places. " +
  "Now I'll gather supporting context on the top liberal contenders. " +
  'Marfa and Crystal City show liberal leanings so far. ' +
  'Research covered the first 10 candidate places; any further places were not researched. ' +
  `A cited politics page titled ${MARFA_TITLE} tracks voting patterns by precinct. ` +
  '**Answer:** Among the places screened, Crystal City, TX has the strongest web support as most liberal.'

const TEXAS_SOURCES = [
  { title: MARFA_TITLE, url: 'https://example.com/marfa-politics' },
  { title: 'Crystal City politics', url: 'https://example.com/crystal-city' },
]

function texasProvider(calls?: { places: readonly string[] }[]) {
  return createStubProvider({
    async research(input) {
      calls?.push({ places: input.places })
      return { prose: TEXAS_PROSE, sources: TEXAS_SOURCES }
    },
  })
}

async function runTexas(partial: Partial<ValidatedIntent> = {}) {
  const calls: { places: readonly string[] }[] = []
  const answer = await runAnswerPipeline({
    intent: intent({
      geographies: ['TX'],
      metricKeys: ['median_gross_rent'],
      ...partial,
    }),
    rows: TX_ROWS,
    researchQuery: TEXAS_Q,
    researchCriteria: [TEXAS_Q],
    queryText: TEXAS_Q,
    provider: texasProvider(calls),
  })
  return { answer, calls }
}

const CO_ROWS: AreaRow[] = [
  { zcta: '81090', name: 'Walsh, CO', metrics: { median_gross_rent: 283, median_home_value: 151100 }, moes: { median_gross_rent: 273, median_home_value: 71979 } },
  { zcta: '81047', name: 'Holly, CO', metrics: { median_gross_rent: 293, median_home_value: 157700 }, moes: { median_gross_rent: 282, median_home_value: 55661 } },
  { zcta: '81334', name: 'Towaoc, CO', metrics: { median_gross_rent: 349, median_home_value: null }, moes: { median_gross_rent: 191, median_home_value: null } },
  { zcta: '81001', name: 'Pueblo, CO', metrics: { median_gross_rent: 1050, median_home_value: 210000 }, moes: { median_gross_rent: 40, median_home_value: 5000 } },
  { zcta: '81611', name: 'Aspen, CO', metrics: { median_gross_rent: 2400, median_home_value: 2400000 }, moes: { median_gross_rent: 300, median_home_value: 200000 } },
  { zcta: '80424', name: 'Breckenridge, CO', metrics: { median_gross_rent: 1900, median_home_value: 1500000 }, moes: { median_gross_rent: 250, median_home_value: 150000 } },
  { zcta: '81301', name: 'Durango, CO', metrics: { median_gross_rent: 1500, median_home_value: 650000 }, moes: { median_gross_rent: 90, median_home_value: 30000 } },
  { zcta: '99901', name: 'Norent, CO', metrics: { median_gross_rent: null, median_home_value: 90000 }, moes: { median_gross_rent: null, median_home_value: 9000 } },
]

const NATURE_PROSE =
  'Durango, CO sits at the edge of a national forest with trail access in every direction. ' +
  'Aspen, CO is surrounded by wilderness and scenic mountain trails. ' +
  'Breckenridge, CO offers outdoor recreation beside national forest land. ' +
  'Norent, CO is ringed by scenic public land and forest.'

const NASH_ROWS: AreaRow[] = [
  { zcta: '37210', name: 'Nashville, TN', metrics: { median_household_income: 43343, median_gross_rent: 1100 }, moes: { median_household_income: 6619, median_gross_rent: 60 } },
  { zcta: '37115', name: 'Nashville, TN', metrics: { median_household_income: 53034, median_gross_rent: 1250 }, moes: { median_household_income: 2860, median_gross_rent: 75 } },
]

const AUSTIN_ROWS: AreaRow[] = [
  { zcta: '78701', name: 'Austin, TX', metrics: { median_gross_rent: 1800, median_home_value: 650000 }, moes: { median_gross_rent: 50, median_home_value: 20000 } },
  { zcta: '78704', name: 'Austin, TX', metrics: { median_gross_rent: 2100, median_home_value: 720000 }, moes: { median_gross_rent: 65, median_home_value: 25000 } },
  { zcta: '78745', name: 'Austin, TX', metrics: { median_gross_rent: 1400, median_home_value: 480000 }, moes: { median_gross_rent: 45, median_home_value: 15000 } },
]
const AUSTIN_ZCTAS = new Set(AUSTIN_ROWS.map((r) => r.zcta))

/* ------------------------------------------------------------------ */
/* The specimen                                                        */
/* ------------------------------------------------------------------ */

describe('the Texas specimen', () => {
  it('decomposes to the combined carry and reads its superlative phrase as unclaimed', () => {
    expect(decomposeResearchCriteria(TEXAS_Q).map((c) => c.id)).toEqual(['combined'])
  })

  it('routes research-first: research names the candidates, not the rent screen', async () => {
    const { answer, calls } = await runTexas()
    expect(answer.status).toBe('verified')
    // The research call received the geography bound, not a
    // cheapest-first screened subset.
    expect(calls.map((c) => c.places)).toEqual([['TX']])
    expect(answer.researchNamedPlaces).toEqual([
      'Crystal City, TX',
      'Marfa, TX',
      'Asherton, TX',
      'Sebastian, TX',
    ])
    // The card is the shortlist, in research order — strongest
    // first — not the state screen in rent order. Runge (the
    // cheapest town, and a non-qualifier) is not on the card.
    expect(answer.places.map((p) => p.name)).toEqual([
      'Crystal City, TX',
      'Marfa, TX',
      'Asherton, TX',
      'Sebastian, TX',
    ])
    expect(answer.places.map((p) => p.name)).not.toContain('Runge, TX')
  })

  it('labels the pulled figures as context and accounts the one criterion', async () => {
    const { answer } = await runTexas()
    expect(answer.summary).toBe(
      'The places named here were named by the cited research for the stated criteria, with Census figures shown for context.',
    )
    expect(answer.summary).not.toContain('measures in this request')
    // The pulled figure still rides each place — as context.
    for (const place of answer.places) {
      expect(place.figures.map((f) => f.key)).toEqual(['median_gross_rent'])
    }
    const evidence = answer.criterionEvidence.filter(
      (e) => e.criterion === 'Outside-Census criteria',
    )
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.status).toBe('met')
  })

  it('renders no working narration, and the conclusion survives de-scaffolded', async () => {
    const { answer } = await runTexas()
    expectNoNarration(answer)
    expect(allRenderedText(answer)).toContain(
      'Among the places screened, Crystal City, TX has the strongest web support as most liberal.',
    )
    // The drops are recorded, not silent.
    const droppedTexts = answer.droppedClaims.map((c) => c.text)
    expect(droppedTexts).toContain(NARRATION_SENTENCE)
    expect(droppedTexts).toContain(
      'What sources say about political character — liberal:',
    )
  })

  it('shows no map for the class', async () => {
    const { answer } = await runTexas()
    expect(resultMapRelevant(answer)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Rendered card: citation render-once                                 */
/* ------------------------------------------------------------------ */

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

describe('the rendered Texas card', () => {
  it('leads with the qualifying shortlist and renders each source once', async () => {
    const { answer } = await runTexas()
    act(() => root.render(<AnswerCard answer={answer} />))
    const headlines = [...container.querySelectorAll('article h3')].map(
      (h) => h.textContent ?? '',
    )
    expect(headlines).toHaveLength(4)
    expect(headlines[0]).toContain('Crystal City, TX')
    const text = container.textContent ?? ''
    expect(text).not.toContain('Runge')
    for (const leaked of LEAKED_STRINGS.slice(0, 5)) expect(text).not.toContain(leaked)
    // The full source-title list rendered after every claim in
    // the specimen; on the cured card each title renders once.
    expect(text.split(MARFA_TITLE).length - 1).toBe(1)
    expect(text.split('Crystal City politics').length - 1).toBe(1)
    expect(text).toContain('with Census figures shown for context')
  })

  it('claimSourceVisibility gives each source to exactly one claim, in render order', async () => {
    const { answer } = await runTexas()
    const visibility = claimSourceVisibility(answer)
    const visible = [...visibility.values()].flat()
    expect(new Set(visible).size).toBe(visible.length)
    expect(visible.sort()).toEqual(TEXAS_SOURCES.map((s) => s.url).sort())
    const firstClaim = answer.places[0]?.claims[0]
    expect(firstClaim && visibility.get(firstClaim)).toEqual(
      TEXAS_SOURCES.map((s) => s.url),
    )
    // A later claim citing already-shown sources shows none.
    const later = answer.places[1]?.claims[0]
    expect(later && visibility.get(later)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* Prose hygiene, as a unit                                            */
/* ------------------------------------------------------------------ */

describe('filterWorkingNarration', () => {
  const noSources: never[] = []

  it('drops every leaked working-narration string from the specimen', () => {
    for (const leaked of LEAKED_STRINGS.slice(0, 5)) {
      const result = filterWorkingNarration(leaked, noSources)
      expect(result.prose).toBe('')
      expect(result.dropped).toEqual([leaked])
    }
  })

  it('drops the question echo, the apparatus explanation, and the coverage meta-line', () => {
    const echo =
      'Question: **most liberal city in Texas** > All 10 named places meet the Census screens — including median_gross_rent — per pre-screening.'
    expect(filterWorkingNarration(echo, noSources).prose).toBe('')
    const apparatus =
      'Rent / income / value figures are shown separately from Census data, not from the web.'
    expect(filterWorkingNarration(apparatus, noSources).prose).toBe('')
    const meta =
      'No web support found for schools, amenities, safety or services as part of the question — not addressed here.'
    expect(filterWorkingNarration(meta, noSources).prose).toBe('')
  })

  it('drops a segment carrying a cited source raw title, keeps the same finding without it', () => {
    const titled = `The ${MARFA_TITLE} page tracks voting patterns by precinct.`
    const result = filterWorkingNarration(titled, [
      { title: MARFA_TITLE, url: 'https://example.com/marfa-politics' },
    ])
    expect(result.prose).toBe('')
    const plain = 'Marfa, TX is described as moderately liberal.'
    expect(filterWorkingNarration(plain, noSources).prose).toBe(plain)
  })

  it('drops colon-terminated header lines and keeps the findings under them', () => {
    const prose =
      '**Crystal City, TX — meets liberal + Census, strongest support as most liberal:**\n' +
      'Described as strongly liberal.'
    const result = filterWorkingNarration(prose, noSources)
    expect(result.prose).toBe('Described as strongly liberal.')
    expect(result.dropped).toHaveLength(1)
  })

  it('keeps the conclusion, stripped of its scaffolding', () => {
    const prose =
      '**Answer:** Among the places screened, Crystal City, TX has the strongest web support as most liberal.'
    expect(filterWorkingNarration(prose, noSources).prose).toBe(
      'Among the places screened, Crystal City, TX has the strongest web support as most liberal.',
    )
  })

  it('keeps substantive findings verbatim', () => {
    const finding =
      'Crystal City, TX is described as strongly liberal and is called the bluest town in red Texas.'
    expect(filterWorkingNarration(finding, noSources).prose).toBe(finding)
  })
})

/* ------------------------------------------------------------------ */
/* The all-conditions battery (owner directive: test for ALL           */
/* conditions — criterion class x question shape x geography)          */
/* ------------------------------------------------------------------ */

describe('battery: Census-only criteria', () => {
  it('superlative x state: the bounded screen is the answer, cheapest first', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['TX'], metricKeys: ['median_gross_rent'] }),
      rows: TX_ROWS,
      queryText: 'What is the cheapest place to live in Texas?',
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.criterionEvidence).toHaveLength(0)
    expect(answer.places.slice(0, 2).map((p) => p.name)).toEqual(['Runge, TX', 'Paducah, TX'])
    // A screen-composed sweep keeps its map: the geography IS the
    // information (the standing chart rule, both directions).
    expect(resultMapRelevant(answer)).toBe(true)
  })

  it('superlative x placeless: the national screen (B1) stays screen-first', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: ['median_gross_rent'] }),
      rows: TX_ROWS,
      queryText: 'What is the cheapest place to live in the United States?',
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places[0]?.name).toBe('Runge, TX')
  })

  it('superlative x named-place: the place screen, cheapest first', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Austin'], metricKeys: ['median_gross_rent'] }),
      rows: AUSTIN_ROWS,
      geographyZctas: AUSTIN_ZCTAS,
      queryText: 'What is the cheapest rent in Austin?',
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(
      answer.places.map((p) => p.figures.find((f) => f.key === 'median_gross_rent')?.value),
    ).toEqual([1400, 1800, 2100])
  })

  it('bounded x state: a stated filter keeps the screen-first path', async () => {
    const text = 'Show me places in Colorado where rent is under $600 a month'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 600 }],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning('Walsh, CO sits beside open prairie.'),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.length).toBeGreaterThan(0)
    for (const place of answer.places) {
      expect(
        place.figures.find((f) => f.key === 'median_gross_rent')?.value,
      ).toBeLessThanOrEqual(600)
    }
  })

  it('bounded x placeless: a stated filter screens nationally', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 400 }],
      }),
      rows: TX_ROWS,
      queryText: 'Show me places where rent is under $400 a month',
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.map((p) => p.name)).toEqual([
      'Runge, TX',
      'Paducah, TX',
      'Loraine, TX',
      'Sebastian, TX',
      'Forsan, TX',
    ])
  })

  it('bounded x named-place: the filtered place screen', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['Austin'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
      }),
      rows: AUSTIN_ROWS,
      geographyZctas: AUSTIN_ZCTAS,
      queryText: 'Show me places in Austin where rent is under $2,000 a month',
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    // Pipeline order is load order for a bounded screen; the card
    // orders by the first criterion at render (orderedPlaces).
    expect(answer.places.map((p) => p.zcta).sort()).toEqual(['78701', '78745'])
    for (const place of answer.places) {
      expect(
        place.figures.find((f) => f.key === 'median_gross_rent')?.value,
      ).toBeLessThanOrEqual(2000)
    }
  })

  it('lookup x named-place: the plain figure card', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['Austin, TX'],
        metricKeys: ['median_home_value'],
      }),
      rows: AUSTIN_ROWS,
      geographyZctas: AUSTIN_ZCTAS,
      queryText: 'What is the median home value in Austin, Texas?',
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(3)
    expect(answer.places[0]?.figures.map((f) => f.key)).toEqual(['median_home_value'])
  })

  it('lookup x state: the state figure card', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['TN'],
        metricKeys: ['median_household_income'],
      }),
      rows: NASH_ROWS,
      geographyZctas: new Set(NASH_ROWS.map((r) => r.zcta)),
      queryText: 'What is the median household income in Tennessee?',
    })
    expect(answer.status).toBe('verified')
    expect(answer.places).toHaveLength(2)
    expect(answer.places[0]?.figures.map((f) => f.key)).toEqual(['median_household_income'])
  })

  it('lookup x placeless (a ZIP): one place, and a one-place map is not relevant', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['96720'],
        metricKeys: ['median_gross_rent'],
      }),
      rows: [
        {
          zcta: '96720',
          name: 'Hilo, HI',
          metrics: { median_gross_rent: 1346 },
          moes: { median_gross_rent: 52 },
        },
      ],
      queryText: 'What is the median gross rent in 96720?',
    })
    expect(answer.status).toBe('verified')
    expect(answer.places).toHaveLength(1)
    expect(resultMapRelevant(answer)).toBe(false)
  })
})

describe('battery: researched-only criteria', () => {
  it('superlative x placeless: the class routes research-first without a geography bound', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: ['median_gross_rent'] }),
      rows: TX_ROWS,
      researchQuery: 'what is the most liberal city in America?',
      researchCriteria: ['what is the most liberal city in America?'],
      queryText: 'what is the most liberal city in America?',
      provider: texasProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toEqual([
      'Crystal City, TX',
      'Marfa, TX',
      'Asherton, TX',
      'Sebastian, TX',
    ])
    expect(answer.summary).toContain('shown for context')
    expectNoNarration(answer)
    expect(resultMapRelevant(answer)).toBe(false)
  })

  it('superlative x named-place, named criterion: the place screen stands (the Nashville shape)', async () => {
    const text = "Where can I move around Nashville that's got good schools and high wages"
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Nashville'], metricKeys: ['median_household_income'] }),
      rows: NASH_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Nashville, TN schools in this area are well regarded. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(2)
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('superlative x named-place, combined-only criterion: the geography fence holds', async () => {
    // The widening is fenced to placeless and state bounds: a
    // named place's own rows are the question's universe, so the
    // screen-first decoration shape stands even for a combined-
    // only superlative (the same fence the Nashville shape pins).
    const text = 'What is the most haunted spot in Nashville?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Nashville'], metricKeys: ['median_household_income'] }),
      rows: NASH_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Nashville, TN is described as one of the most haunted cities in the South. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(2)
    expectNoNarration(answer)
  })

  it('bounded (top-N) x state: the asked count bounds the shortlist', async () => {
    const text = 'What are the top three most liberal cities in Texas?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['TX'], metricKeys: ['median_gross_rent'] }),
      rows: TX_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: texasProvider(),
    })
    expect(answer.requestedCount).toBe(3)
    expect(answer.places.map((p) => p.name)).toEqual([
      'Crystal City, TX',
      'Marfa, TX',
      'Asherton, TX',
    ])
    expectNoNarration(answer)
  })

  it('bounded (top-N) x placeless: the shortfall stays visible on the answer', async () => {
    const text = 'What are the top five places that have the best schools?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Durango, CO schools are well regarded. Aspen, CO schools sit in a mountain district. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.requestedCount).toBe(5)
    expect(answer.places.map((p) => p.name)).toEqual(['Durango, CO', 'Aspen, CO'])
    expectNoNarration(answer)
  })

  it('lookup x named-place: the lookup card carries the researched claim', async () => {
    const text = 'Does Austin have good schools?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['Austin'],
        metricKeys: ['median_home_value'],
      }),
      rows: AUSTIN_ROWS,
      geographyZctas: AUSTIN_ZCTAS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Austin, TX schools are well regarded by the state report. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places[0]?.claims.length).toBeGreaterThan(0)
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('lookup x placeless (a ZIP) with a researched criterion: the one-place card, accounted', async () => {
    const text = 'What is the median gross rent in 96720, and are the schools good?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['96720'],
        metricKeys: ['median_gross_rent'],
      }),
      rows: [
        {
          zcta: '96720',
          name: 'Hilo, HI',
          metrics: { median_gross_rent: 1346 },
          moes: { median_gross_rent: 52 },
        },
      ],
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Hilo, HI has well-regarded schools. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places).toHaveLength(1)
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })
})

describe('battery: mixed criteria (researched + a decomposed Census measure)', () => {
  it('superlative x state: the Colorado intersection stands (A4 shape, with narration in the prose)', async () => {
    const text = 'what city in Colorado has the best nature and the lowest cost of living?'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent', 'median_home_value'],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(`${NATURE_PROSE} ${NARRATION_SENTENCE}`),
    })
    expect(answer.researchNamedPlaces).toEqual([
      'Durango, CO',
      'Aspen, CO',
      'Breckenridge, CO',
      'Norent, CO',
    ])
    expect(answer.places.map((p) => p.name)).toEqual([
      'Durango, CO',
      'Breckenridge, CO',
      'Aspen, CO',
      'Norent, CO',
    ])
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')?.status,
    ).toBe('met')
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')?.status,
    ).toBe('met')
    expectNoNarration(answer)
    expect(resultMapRelevant(answer)).toBe(false)
  })

  it('superlative x placeless: sentence 2 stands', async () => {
    const text =
      'What are the top five places that have the best schools but also the least average cost of living?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: ['median_gross_rent'] }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Durango, CO schools are well regarded and the town sits beside a national forest. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchCriteria.map((c) => c.id)).toEqual(['schools', 'cost_of_living'])
    expect(answer.requestedCount).toBe(5)
    expect(answer.places.map((p) => p.name)).toEqual(['Durango, CO'])
    expectNoNarration(answer)
  })

  it('superlative x named-place: the place screen stands, both criteria accounted', async () => {
    const text = 'Where in Nashville has the best schools and the lowest cost of living?'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Nashville'], metricKeys: ['median_gross_rent'] }),
      rows: NASH_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Nashville, TN schools in this area are well regarded. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places).toHaveLength(2)
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('bounded x state: a stated filter + a researched criterion stays screen-first', async () => {
    const text = 'Show me places in Colorado with great nature and rent under $2,000 a month'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['CO'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Walsh, CO sits beside open prairie with nature trails in every direction. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.map((p) => p.name)).not.toContain('Aspen, CO')
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('bounded x placeless: a stated filter + a researched criterion stays screen-first', async () => {
    const text = 'Show me places with good schools and rent under $1,000 a month'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1000 }],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Walsh, CO schools are well regarded. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.map((p) => p.name)).toEqual(['Walsh, CO', 'Holly, CO', 'Towaoc, CO'])
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('bounded x named-place: the filtered place screen, researched criterion accounted', async () => {
    const text = 'Show me places in Nashville with good schools and rent under $1,200 a month'
    const answer = await runAnswerPipeline({
      intent: intent({
        geographies: ['Nashville'],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1200 }],
      }),
      rows: NASH_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Nashville, TN schools in this area are well regarded. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places.map((p) => p.zcta)).toEqual(['37210'])
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('lookup x state: a lookup carrying a named researched criterion routes research-first', async () => {
    const text = 'What is the median rent in Colorado, and how is the nature access?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['CO'],
        metricKeys: ['median_gross_rent'],
      }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(`${NATURE_PROSE} ${NARRATION_SENTENCE}`),
    })
    expect(answer.researchNamedPlaces).toEqual([
      'Durango, CO',
      'Aspen, CO',
      'Breckenridge, CO',
      'Norent, CO',
    ])
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })

  it('lookup x named-place: the lookup card carries figures and the researched claim', async () => {
    const text = 'What is the median home value in Austin, and how are the schools?'
    const answer = await runAnswerPipeline({
      intent: intent({
        mode: 'lookup',
        geographies: ['Austin'],
        metricKeys: ['median_home_value'],
      }),
      rows: AUSTIN_ROWS,
      geographyZctas: AUSTIN_ZCTAS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: providerReturning(
        `Austin, TX schools are well regarded by the state report. ${NARRATION_SENTENCE}`,
      ),
    })
    expect(answer.status).toBe('verified')
    expect(answer.researchNamedPlaces).toBeUndefined()
    expect(answer.places[0]?.figures.map((f) => f.key)).toEqual(['median_home_value'])
    expect(
      answer.criterionEvidence.find((e) => e.criterion === 'School quality')?.status,
    ).toBe('met')
    expectNoNarration(answer)
  })
})
