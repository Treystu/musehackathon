// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import { resetPlaceIndexCache } from '../../src/core/zcta-place-index'
import { resetCountyIndexCache } from '../../src/core/zcta-county-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { VARS } from '../../src/core/plugins/acs'
import {
  RESEARCH_CRITERION_CATALOG,
  decomposeResearchCriteria,
} from '../../src/core/ai/answer'
import { decompositionReachesPipeline } from '../../src/ui/ai/answer-runner'
import { rescueNationalScreen, stateNamedInWords } from '../../src/core/ai/national-screen'
import type { ValidatedIntent } from '../../src/core/ai/provider'

/**
 * P3b pins — SEAM REACHABILITY (battery re-run on shipped P3,
 * rerun-p3 RESULTS.md: A3 PARTIAL, C5 OPEN, A4 OPEN, D6 PARTIAL).
 * One App-seam pin per case in the re-run's own shapes (same intent
 * and research stubs, same designed figures as
 * drive-scratch/rerun-p3), plus the cure-2 correspondence pin and a
 * B1 no-regression pin. The re-run harness RECORDED terminals; these
 * pins ASSERT the cured terminals, so a cure that regresses to
 * unreachable fails here instead of at the next battery.
 */

const P = {
  A3: "I'm retiring next year and want somewhere warm with affordable homes and good hospitals nearby.",
  A4: 'Remote worker, $70k salary — where in Colorado could I live well on that?',
  C5: 'Which ZIP codes in Texas have median home value under $250,000 and good internet access?',
  D6: '¿Cuál es el lugar más barato para vivir en California?',
  B1: "What's the cheapest place to live?",
} as const

type Z = {
  rent: number; rentM: number; burden: number; burdenM: number
  home: number; homeM: number; income: number; incomeM: number
  hh: number; hhM: number; pop: number; noint: number
}
const D = (p: Partial<Z>): Z => ({
  rent: 1300, rentM: 60, burden: 30, burdenM: 3, home: 300000, homeM: 15000,
  income: 60000, incomeM: 3000, hh: 8000, hhM: 250, pop: 20000, noint: 1000, ...p,
})
const BY_ZCTA: Record<string, Z> = {
  '99501': D({ rent: 1500, home: 380000, income: 72000 }),
  '99701': D({ rent: 1300, home: 320000, income: 68000 }),
  '99801': D({ rent: 1450, home: 400000, income: 75000 }),
  '97201': D({ rent: 1600, home: 550000, income: 82000 }),
  '97401': D({ rent: 1400, home: 420000, income: 58000 }),
  '97301': D({ rent: 1350, home: 380000, income: 62000 }),
  '04101': D({ rent: 1550, home: 450000, income: 65000 }),
  '04401': D({ rent: 1050, home: 220000, income: 52000 }),
  '04330': D({ rent: 1150, home: 260000, income: 58000 }),
  '94035': D({ rent: 3400 }), '94039': D({ rent: 3400 }), '94040': D({ rent: 3400 }),
  '94041': D({ rent: 3400 }), '94042': D({ rent: 3400 }), '94043': D({ rent: 3400 }),
  '95060': D({ rent: 2600 }), '95061': D({ rent: 2600 }), '95062': D({ rent: 2600 }),
  '95064': D({ rent: 2600 }), '95065': D({ rent: 2600 }),
  '93301': D({ rent: 1150 }), '94110': D({ rent: 2800 }), '94601': D({ rent: 1900 }),
  '95112': D({ rent: 2400 }), '95814': D({ rent: 1600 }), '90012': D({ rent: 1750 }),
  '92101': D({ rent: 1850 }), '93722': D({ rent: 1250 }), '90210': D({ rent: 3200 }),
  '78701': D({ rent: 1800, home: 450000, homeM: 30000, income: 75000, hh: 7000, pop: 15000, noint: 500 }),
  '73301': D({ rent: 1800 }),
  '75034': D({ rent: 2100 }),
  '78520': D({ rent: 950 }),
  '77002': D({ rent: 1250, home: 220000, homeM: 12000, income: 52000, hh: 8000, pop: 18000, noint: 4000 }),
  '79901': D({ rent: 950, home: 180000, homeM: 9000, income: 45000, hh: 9000, pop: 20000, noint: 1500 }),
  '78201': D({ rent: 1100, home: 210000, homeM: 11000, income: 48000, hh: 10000, pop: 22000, noint: 2500 }),
  '75201': D({ rent: 1500, home: 380000, homeM: 22000, income: 70000, hh: 6000, pop: 12000, noint: 600 }),
  '80202': D({ rent: 1750 }), '80301': D({ rent: 2100 }), '80521': D({ rent: 1550 }),
  '80903': D({ rent: 1350 }), '81611': D({ rent: 2800 }),
  '60601': D({ rent: 1400, home: 320000, income: 70000 }),
  '60614': D({ rent: 1650, home: 450000, income: 85000 }),
  '40701': D({ rent: 800, income: 42000 }),
  '40771': D({ rent: 850, income: 43000 }),
  '85701': D({ rent: 1250 }),
  '96720': D({ rent: 1450, home: 340000, income: 68000, hh: 16000, pop: 45000, noint: 2000 }),
  '96749': D({ rent: 1300 }), '96778': D({ rent: 1400 }), '96821': D({ rent: 2946 }),
}
const ALL_ZCTAS = Object.keys(BY_ZCTA)

const VAR_VALUE: Record<string, (z: Z) => number> = {
  [VARS.medianGrossRent]: (z) => z.rent, [VARS.medianGrossRentMoe]: (z) => z.rentM,
  [VARS.medianRentBurden]: (z) => z.burden, [VARS.medianRentBurdenMoe]: (z) => z.burdenM,
  [VARS.medianHomeValue]: (z) => z.home, [VARS.medianHomeValueMoe]: (z) => z.homeM,
  [VARS.medianHouseholdIncome]: (z) => z.income, [VARS.medianHouseholdIncomeMoe]: (z) => z.incomeM,
  [VARS.households]: (z) => z.hh, [VARS.householdsMoe]: (z) => z.hhM,
  [VARS.population]: (z) => z.pop, [VARS.noInternetAccess]: (z) => z.noint,
}

const CLARIFIED_EMPTY = { mode: 'lookup', geographies: [], metricKeys: [], filters: [], clarificationNeeded: true }

/** The re-run's intent shapes, verbatim per case. */
const INTENT_BY_PROMPT: Record<string, unknown> = {
  [P.A3]: { mode: 'lookup', geographies: [], metricKeys: ['median_home_value'], filters: [], clarificationNeeded: true },
  [P.A4]: { mode: 'lookup', geographies: ['CO'], metricKeys: [], filters: [], clarificationNeeded: true },
  [P.C5]: { mode: 'sweep_filter', geographies: ['Texas'], metricKeys: ['median_home_value'], filters: [{ metricKey: 'median_home_value', op: 'lt', value: 250000 }], clarificationNeeded: false },
  [P.D6]: CLARIFIED_EMPTY,
  [P.B1]: CLARIFIED_EMPTY,
}

const SRC = (title: string, url: string) => ({ title, url })
const RESEARCH_BY_PROMPT: Record<string, { prose: string; sources: { title: string; url: string }[] }> = {
  [P.A3]: {
    prose:
      'Tucson, AZ has a major hospital campus in the city, the cited hospital directory reports. ' +
      'Brownsville, TX has a general hospital serving the city, the cited hospital directory reports.',
    sources: [SRC('National hospital directory', 'https://example.org/hospitals')],
  },
  [P.A4]: {
    prose:
      'Colorado Springs, CO is described in the cited guide as a lower-cost city for remote workers. ' +
      'Fort Collins, CO is described in the cited guide as a lower-cost city for remote workers.',
    sources: [SRC('Colorado remote-work guide', 'https://example.org/colorado')],
  },
}

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let log = { research: 0, intent: 0, census: 0 }

async function readQueryText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  try {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '')
    const body = typeof raw === 'string' && raw ? JSON.parse(raw) : null
    return (body as { queryText?: string } | null)?.queryText ?? ''
  } catch { return '' }
}

function installFetch() {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json')) return new Response(PLACES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/map/zcta-counties.json')) return new Response(COUNTIES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('tigerweb.geo.census.gov')) {
      const where = new URL(url).searchParams.get('where') ?? ''
      const bounds = [...where.matchAll(/'(\d{5})'/g)].map((m) => m[1]!)
      const lo = bounds[0] ?? '00000'
      const hi = bounds[1] ?? '99999'
      const features = ALL_ZCTAS.filter((z) => z >= lo && z <= hi).map((z) => ({ attributes: { ZCTA5: z } }))
      return jsonResponse(200, { features })
    }
    if (url.includes('api.census.gov')) {
      log.census += 1
      const params = new URL(url).searchParams
      const vars = (params.get('get') ?? '').split(',').filter(Boolean)
      const geo = params.get('for') ?? ''
      const zctas = (geo.split(':')[1] ?? '').split(',').filter(Boolean)
      const header = [...vars, 'zip code tabulation area']
      const rows = zctas.map((z) => {
        const rec = BY_ZCTA[z] ?? D({})
        return header.map((h) => {
          if (h === 'NAME') return `ZCTA5 ${z}`
          if (h === 'zip code tabulation area') return z
          const pick = VAR_VALUE[h]
          if (pick) return String(pick(rec))
          if (h.endsWith('M')) return '10'
          return '1000'
        })
      })
      return jsonResponse(200, [header, ...rows])
    }
    if (url.includes('/api/muse/intent')) {
      log.intent += 1
      const q = await readQueryText(input, init)
      return jsonResponse(200, { intent: INTENT_BY_PROMPT[q] ?? CLARIFIED_EMPTY })
    }
    if (url.includes('/api/muse/research')) {
      log.research += 1
      const q = await readQueryText(input, init)
      const stub = RESEARCH_BY_PROMPT[q] ??
        Object.entries(RESEARCH_BY_PROMPT).find(([prompt]) => q.startsWith(prompt))?.[1]
      if (stub) return jsonResponse(200, stub)
      return jsonResponse(200, { prose: 'No specific findings are stated in this stub response.', sources: [SRC('Stub source', 'https://example.org/stub')] })
    }
    return jsonResponse(404, { error: 'unstubbed' })
  }
  vi.stubGlobal('fetch', vi.fn(handler))
}

let container: HTMLDivElement
let root: Root

function render(node: ReactNode) { act(() => root.render(node)) }

async function ask(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

async function waitFor(predicate: () => boolean, budgetMs = 60000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); ok = predicate() })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string { return container.textContent ?? '' }

const NOTE_TEXTS = ['could not be composed just now', 'could not be loaded, so this question', 'More detail is needed before anything runs']

function terminalReached(): boolean {
  if (container.querySelector('[aria-label="Answer"]')) return true
  if (container.querySelector('[aria-label="Clarify the request"]')) return true
  const text = pageText()
  return NOTE_TEXTS.some((t) => text.includes(t))
}

async function runPrompt(prompt: string): Promise<{ card: string; page: string }> {
  render(<App />)
  await ask(prompt)
  const reached = await waitFor(terminalReached, 90000)
  await act(async () => { await new Promise((r) => setTimeout(r, 2500)) })
  expect(reached).toBe(true)
  const card = container.querySelector('[aria-label="Answer"]')
  return { card: card?.textContent ?? '', page: pageText() }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  log = { research: 0, intent: 0, census: 0 }
  localStorage.clear()
  // Item 17: the Ask session persists to sessionStorage (the reload
  // cure); a previous case's session would otherwise restore into
  // this case's mount, the same hazard the localStorage clear
  // already guards for its channel.
  sessionStorage.clear()
  resetBudget(); _resetPacing(); resetPlaceIndexCache(); resetCountyIndexCache()
  ;(globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL] = { CENSUS_APP_KEY: 'fake-shared-key-for-tests' }
  installFetch()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  resetPlaceIndexCache(); resetCountyIndexCache()
  delete (globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL]
})

describe('P3b seam reachability (App mount, re-run shapes)', () => {
  it('A3: retained measure no longer excludes research-first at the pipeline', async () => {
    const { card, page } = await runPrompt(P.A3)
    expect(card).not.toBe('')
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    // The research-named places appear (the re-run's card was a
    // 51-place nationwide dump without either of them)...
    expect(card).toContain('Tucson, AZ')
    expect(card).toContain('Brownsville, TX')
    // ...WITH the retained home-value measure's figures pulled.
    expect(card).toContain('Median home value')
    expect(card).toContain('$300,000')
    // Hospital claims attach to the shown places they name.
    expect(card).toContain('has a major hospital campus')
    // Every stated criterion is accounted: amenities served,
    // warm named as not measurable.
    expect(card).toContain('Amenities')
    expect(card).toContain('Warm climate')
    expect(card).toContain('not measurable')
    expect(page).not.toContain('More detail is needed before anything runs')
  }, 180_000)

  it('C5: internet decomposition reaches the card through the App seam', async () => {
    const { card } = await runPrompt(P.C5)
    expect(card).not.toBe('')
    // The internet criterion is ON the card, decomposed onto the
    // no-internet figure, with the figure shown per place.
    expect(card).toContain('Internet access')
    expect(card).toContain('Households with no internet access')
    expect(card).toContain('4,000')
    // Houston's 4,000 of 8,000 households fails the criterion, so
    // the meet-all claim falls to the summary-claim rule.
    expect(card).not.toContain('meet all of the stated Census criteria')
    expect(card).toContain('Internet access — partially measured')
    // Decomposition fired without a research call: needsResearch
    // has no internet arm and still owns the call decision.
    expect(log.research).toBe(0)
  }, 180_000)

  it('A4: the stated salary is accounted on a Colorado card, not a clarification', async () => {
    const { card, page } = await runPrompt(P.A4)
    expect(card).not.toBe('')
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    // A Colorado card naming researched places, with rent figures.
    expect(card).toContain('Colorado Springs, CO')
    expect(card).toContain('Fort Collins, CO')
    expect(card).toContain('Median gross rent')
    expect(log.research).toBeGreaterThan(0)
    // The salary is visibly accounted: the reader's figure and the
    // derived anchor both appear in the criterion accounting.
    expect(card).toContain('Affordability on the stated income')
    expect(card).toContain('$70,000')
    expect(card).toContain('$1,750')
    expect(page).not.toContain('More detail is needed before anything runs')
  }, 180_000)

  it('D6: a state named only in the reader words bounds the rescue screen', async () => {
    const { card } = await runPrompt(P.D6)
    expect(card).not.toBe('')
    // California-bounded: Bakersfield leads on the designed
    // figures (the D6b control's order), Corbin, KY is absent.
    expect(card).toContain('Bakersfield, CA')
    expect(card.indexOf('Bakersfield, CA')).toBeLessThan(card.indexOf('Fresno, CA'))
    expect(card).not.toContain('Corbin')
  }, 180_000)

  it('B1: a genuinely placeless superlative still screens nationwide', async () => {
    const { card } = await runPrompt(P.B1)
    expect(card).not.toBe('')
    expect(card).toContain('Corbin, KY')
    expect(stateNamedInWords(P.B1)).toBeNull()
  }, 180_000)
})

describe('cure 4 rescue seam: the recovered bound is the disclosed bound', () => {
  // The panel's rescued note and the understood-request chip are
  // both rendered from the rescued intent's geographies (AskPanel
  // accept(): "This screens <geographies> by <label>, lowest
  // first"), so the intent IS the disclosure surface: a bounded
  // rescue for D6 and a placeless one for B1 pin the disclosure at
  // the seam that produces it.
  const emptyParse: ValidatedIntent = {
    mode: 'lookup',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: true,
  }

  it('recovers California from the D6 words into a bounded screen intent', () => {
    expect(stateNamedInWords(P.D6)).toBe('California')
    const rescued = rescueNationalScreen(emptyParse, P.D6)
    expect(rescued?.geographies).toEqual(['California'])
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
    expect(rescued?.mode).toBe('sweep_filter')
  })

  it('keeps the B1 shape placeless: no state in the words, no bound recovered', () => {
    const rescued = rescueNationalScreen(emptyParse, P.B1)
    expect(rescued?.geographies).toEqual([])
    expect(rescued?.metricKeys).toEqual(['median_gross_rent'])
  })
})

describe('cure 2 correspondence pin: every catalog criterion reaches the pipeline', () => {
  // One sample phrase per catalog entry, keyed by entry id. The
  // test enumerates the SHIPPED catalog: a future entry with no
  // sample here fails, and a sample that stops decomposing — or
  // stops passing the App-seam gate — fails. This is the pin whose
  // absence let the internet entry ship unreachable in P3.
  const SAMPLE_BY_ID: Record<string, string> = {
    schools: 'places with good schools',
    fast_food: 'places with fast food restaurants',
    restaurants: 'places with good restaurants',
    coffee: 'places with coffee shops nearby',
    groceries: 'places with groceries nearby',
    safety: 'the safest streets in town',
    walkability: 'walkable streets',
    amenities: 'places with hospitals nearby',
    farmers_markets: 'places with farmers markets',
    climate: 'somewhere with a warm climate',
    nature: 'places with nature nearby',
    crowding: 'the most crowded housing',
    poverty: 'the state with the most poverty',
    attainment: 'towns with the most college graduates',
    current_events: 'the latest housing news',
    internet: 'places with good internet access',
    cost_of_living: 'places with a lower cost of living',
    salary: 'somewhere I can live on a $70k salary',
  }

  it('covers every catalog entry with a sample', () => {
    for (const entry of RESEARCH_CRITERION_CATALOG) {
      expect(SAMPLE_BY_ID[entry.id], `no sample for catalog entry ${entry.id}`).toBeDefined()
    }
  })

  it('decomposes every sample to its entry and passes the App-seam gate without the lexical trigger', () => {
    for (const entry of RESEARCH_CRITERION_CATALOG) {
      const sample = SAMPLE_BY_ID[entry.id]!
      expect(
        decomposeResearchCriteria(sample).map((c) => c.id),
        `sample for ${entry.id} does not decompose to it`,
      ).toContain(entry.id)
      // research=false is the point: reachability must not depend
      // on needsResearch, whose arms are a separate, smaller list.
      expect(
        decompositionReachesPipeline(sample, false),
        `catalog entry ${entry.id} is unreachable at the App seam`,
      ).toBe(true)
    }
  })
})
