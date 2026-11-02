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

/**
 * P2c — views-layer county coherence (views_layer_contradiction,
 * the residual from the P2b confirmation re-run, 2026-11-02).
 *
 * The re-run cured the answer area (Boulder County $81,930 and the
 * Denver/Boulder comparison both composed) but executeIntent's run
 * note still read "No ZIP code could be resolved..." beside those
 * working cards (Jev 0.98/0.99), because the views layer resolved
 * geographies without the county index and without waiting for the
 * indexes it does read — measured in the re-run harness: place and
 * county were both still loading when execution ran, and the place
 * index carries no Denver County record in any state. These pins
 * mount the real App in the re-run's shapes (shipped place + county
 * indexes from disk, wire-shaped Census/intent stubs, the battery-c
 * designed figures) and assert, where the re-run only recorded:
 * county questions open their member ZIPs in the comparison and the
 * false note never renders; a genuinely unresolvable county keeps
 * BOTH notes, agreeing; a place question is unchanged.
 */

const PROMPT_C3 = "What's the median household income in Boulder County, Colorado?"
const PROMPT_C4 = 'Compare Denver County and Boulder County for affordability'
const PROMPT_UNRESOLVABLE = "What's the median household income in Atlantis County, Colorado?"
const PROMPT_HILO = "What's the median household income in Hilo, Hawaii?"

const VIEWS_NOTE =
  'No ZIP code could be resolved from the places in this request, so nothing was opened.'
const UNRESOLVED_NOTE =
  'The place named in this question could not be resolved, so no answer was composed.'

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
  // Boulder County members (battery-c designed figures)
  '80301': D({ rent: 1800, rentM: 100, home: 850000, homeM: 40000, income: 90000, incomeM: 4000, hh: 12000, pop: 30000, noint: 600 }),
  '80302': D({ rent: 1600, rentM: 80, home: 700000, homeM: 35000, income: 70000, incomeM: 3500, hh: 4000, pop: 10000, noint: 300 }),
  '80471': D({ rent: 900, rentM: 45, home: 280000, homeM: 14000, income: 41000, incomeM: 2100, hh: 1200, pop: 3000, noint: 250 }),
  // Denver County members (battery-c designed figures)
  '80202': D({ rent: 1500, rentM: 60, home: 550000, homeM: 25000, income: 65000, incomeM: 3000, hh: 9000, pop: 20000, noint: 900 }),
  '80203': D({ rent: 1700, rentM: 60, home: 600000, homeM: 28000, income: 75000, incomeM: 3200, hh: 9500, pop: 20000, noint: 950 }),
  // Hilo, HI (the place-question regression case)
  '96720': D({ rent: 1450, rentM: 52, home: 420000, homeM: 20000, income: 62000, incomeM: 3100, hh: 15000, pop: 45000, noint: 2000 }),
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

const INTENT_BY_PROMPT: Record<string, unknown> = {
  [PROMPT_C3]: { mode: 'lookup', geographies: ['Boulder County, CO'], metricKeys: ['median_household_income'], filters: [], clarificationNeeded: false },
  [PROMPT_C4]: { mode: 'compare', geographies: ['Denver County, CO', 'Boulder County, CO'], metricKeys: ['median_gross_rent', 'median_home_value'], filters: [], clarificationNeeded: false },
  [PROMPT_UNRESOLVABLE]: { mode: 'lookup', geographies: ['Atlantis County, CO'], metricKeys: ['median_household_income'], filters: [], clarificationNeeded: false },
  [PROMPT_HILO]: { mode: 'lookup', geographies: ['Hilo, HI'], metricKeys: ['median_household_income'], filters: [], clarificationNeeded: false },
}
const FALLBACK_INTENT = { mode: 'lookup', geographies: [], metricKeys: [], filters: [], clarificationNeeded: true }

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
      let queryText = ''
      try {
        const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '')
        const body = typeof raw === 'string' && raw ? JSON.parse(raw) : null
        queryText = (body as { queryText?: string } | null)?.queryText ?? ''
      } catch { /* fall through to the fallback intent */ }
      return jsonResponse(200, { intent: INTENT_BY_PROMPT[queryText] ?? FALLBACK_INTENT })
    }
    if (url.includes('/api/muse/research')) {
      return jsonResponse(200, { prose: '', sources: [] })
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

async function waitFor(predicate: () => boolean, budgetMs = 90000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); ok = predicate() })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string { return container.textContent ?? '' }
function answerText(): string {
  return container.querySelector('[aria-label="Answer"]')?.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  // Item 17: the Ask session persists to sessionStorage (the reload
  // cure); a previous case's session would otherwise restore into
  // this case's mount, the same hazard the localStorage clear and
  // the URL reset below already guard for their channels.
  sessionStorage.clear()
  // The comparison follows the selection into the URL; a previous
  // case's county members would otherwise restore into this case's
  // mount and stand in its comparison before it asks anything.
  window.history.replaceState(null, '', window.location.pathname)
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

describe('P2c views-layer county coherence (views_layer_contradiction cure)', () => {
  it('C3 shape: Boulder County card renders with NO views note anywhere on the page', async () => {
    render(<App />)
    await ask(PROMPT_C3)
    // The execution note must have landed (opened, or the false
    // note) before its absence can be asserted — an early read
    // would pass vacuously while the run was still resolving.
    expect(
      await waitFor(() => answerText().includes('Boulder County') && pageText().includes('Opened')),
    ).toBe(true)
    expect(answerText()).toContain('$81,930')
    // The shipped crosswalk assigns Boulder County 18 member ZIPs;
    // the views layer opens on exactly those members now.
    expect(pageText()).toContain('Opened 18 places in the comparison.')
    expect(pageText()).not.toContain(VIEWS_NOTE)
    expect(pageText()).not.toContain(UNRESOLVED_NOTE)
  }, 180_000)

  it('C4 shape: Denver vs Boulder County card renders both counties with NO views note', async () => {
    render(<App />)
    await ask(PROMPT_C4)
    expect(
      await waitFor(
        () =>
          answerText().includes('Denver County') &&
          answerText().includes('Boulder County') &&
          pageText().includes('Opened'),
      ),
    ).toBe(true)
    const card = answerText()
    expect(card).toContain('$1,600')
    expect(card).toContain('$1,691')
    expect(card).toContain('$575,000')
    expect(card).toContain('$775,349')
    // 31 Denver County members + 18 Boulder County members.
    expect(pageText()).toContain('Opened 49 places in the comparison.')
    expect(pageText()).not.toContain(VIEWS_NOTE)
    expect(pageText()).not.toContain(UNRESOLVED_NOTE)
  }, 180_000)

  it('Atlantis County control: the views note AND the answer-area note both still render', async () => {
    render(<App />)
    await ask(PROMPT_UNRESOLVABLE)
    expect(
      await waitFor(() => pageText().includes(VIEWS_NOTE) && answerText().includes(UNRESOLVED_NOTE)),
    ).toBe(true)
    // No card, no figure: the two notes agree because nothing
    // resolved anywhere — the control the false-note cure must not
    // suppress.
    expect(answerText()).not.toContain('$')
  }, 180_000)

  it('place regression: a Hilo lookup renders its card and neither note', async () => {
    render(<App />)
    await ask(PROMPT_HILO)
    expect(
      await waitFor(() => answerText().includes('Hilo') && pageText().includes('Opened')),
    ).toBe(true)
    expect(answerText()).toContain('$62,000')
    expect(pageText()).toContain('Opened 1 place in the comparison.')
    expect(pageText()).not.toContain(VIEWS_NOTE)
    expect(pageText()).not.toContain(UNRESOLVED_NOTE)
  }, 180_000)
})
