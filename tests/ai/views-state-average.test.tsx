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
 * P2d — views-layer state-average coherence
 * (views_state_average_place_name_collision, closing battery
 * cluster C re-run on be13e7e, 2026-11-02).
 *
 * The re-run's C6 card was correct — Hilo 96720 burden 32% beside
 * the Hawaii state average 32.31% over 6 ZIP areas — but
 * executeIntent resolved the "Hawaii" side through place-name
 * search to Hawaiian Acres (96760) and opened 96720 + 96760 in the
 * views comparison, whose table presented Hawaiian Acres as the
 * second comparison place (views_layer_contradiction Noul 0.99).
 * These pins mount the real App in the re-run's shapes (shipped
 * place + county indexes from disk, wire-shaped Census/intent
 * stubs, the closing-c designed figures) and assert, where the
 * re-run only recorded: a state-average side opens no place and is
 * never substituted, the run note carries the aggregate to the
 * answer card, and the ordinary two-place and county comparisons
 * executeIntent already served are unchanged.
 */

const PROMPT_C6 = 'How does 96720 compare to the Hawaii state average for rent burden?'
const PROMPT_STATE_ONLY = "What's the median rent burden in Hawaii?"
const PROMPT_C1 = 'Compare Hilo, HI and East Honolulu, HI for rent and home values'
const PROMPT_C4 = 'Compare Denver County and Boulder County for affordability'

const VIEWS_NOTE =
  'No ZIP code could be resolved from the places in this request, so nothing was opened.'
const STATE_AVERAGE_NOTE = 'The Hawaii state average is shown on the answer card.'

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
  // Hawaii (closing-c designed figures; the state average over
  // these 6 loaded rows is the population-weighted 32.31 the
  // re-run verified: 4,685,000 / 145,000)
  '96720': D({ rent: 1346, rentM: 52, burden: 32, burdenM: 3, home: 340000, homeM: 15000, income: 68000, hh: 16000, pop: 45000, noint: 2000 }),
  '96821': D({ rent: 2946, rentM: 338, burden: 28, home: 1200000, homeM: 80000, income: 135000, hh: 9000, pop: 25000, noint: 300 }),
  '96749': D({ rent: 1500, rentM: 70, burden: 35, home: 380000, income: 62000, hh: 7000, pop: 20000, noint: 1200 }),
  '96778': D({ rent: 1400, rentM: 65, burden: 33, home: 350000, income: 60000, hh: 5500, pop: 15000, noint: 900 }),
  '96813': D({ rent: 1800, rentM: 90, burden: 30, home: 650000, income: 80000, hh: 11000, pop: 30000, noint: 800 }),
  '96760': D({ rent: 1100, rentM: 55, burden: 45, burdenM: 4, home: 260000, income: 42000, hh: 3500, pop: 10000, noint: 1100 }),
  // Boulder County members (views-county-note designed figures)
  '80301': D({ rent: 1800, rentM: 100, home: 850000, homeM: 40000, income: 90000, incomeM: 4000, hh: 12000, pop: 30000, noint: 600 }),
  '80302': D({ rent: 1600, rentM: 80, home: 700000, homeM: 35000, income: 70000, incomeM: 3500, hh: 4000, pop: 10000, noint: 300 }),
  '80471': D({ rent: 900, rentM: 45, home: 280000, homeM: 14000, income: 41000, incomeM: 2100, hh: 1200, pop: 3000, noint: 250 }),
  // Denver County members (views-county-note designed figures)
  '80202': D({ rent: 1500, rentM: 60, home: 550000, homeM: 25000, income: 65000, incomeM: 3000, hh: 9000, pop: 20000, noint: 900 }),
  '80203': D({ rent: 1700, rentM: 60, home: 600000, homeM: 28000, income: 75000, incomeM: 3200, hh: 9500, pop: 20000, noint: 950 }),
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
  [PROMPT_C6]: { mode: 'compare', geographies: ['96720', 'Hawaii'], metricKeys: ['median_rent_burden_pct'], filters: [], clarificationNeeded: false },
  [PROMPT_STATE_ONLY]: { mode: 'lookup', geographies: ['Hawaii'], metricKeys: ['median_rent_burden_pct'], filters: [], clarificationNeeded: false },
  [PROMPT_C1]: { mode: 'compare', geographies: ['Hilo, HI', 'East Honolulu, HI'], metricKeys: ['median_gross_rent', 'median_home_value'], filters: [], clarificationNeeded: false },
  [PROMPT_C4]: { mode: 'compare', geographies: ['Denver County, CO', 'Boulder County, CO'], metricKeys: ['median_gross_rent', 'median_home_value'], filters: [], clarificationNeeded: false },
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
  // The comparison follows the selection into the URL; a previous
  // case's selection would otherwise restore into this case's
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

describe('P2d views-layer state-average coherence (views_state_average_place_name_collision cure)', () => {
  it('C6 shape: the card state average stands, and the views comparison opens only 96720 — no Hawaiian Acres anywhere', async () => {
    render(<App />)
    await ask(PROMPT_C6)
    // The execution note must have landed (opened + state-average
    // sentence, or the old collision) before its content can be
    // asserted — an early read would pass vacuously while the run
    // was still resolving.
    expect(
      await waitFor(
        () => answerText().includes('Hawaii state average') && pageText().includes('state average is shown on the answer card'),
      ),
    ).toBe(true)
    // The card's aggregate figure, verified in the re-run.
    expect(answerText()).toContain('32.31')
    expect(answerText()).toContain('Hilo')
    // The views layer opened the one real place, and its note
    // carries the state-average side to the card instead of
    // substituting a place for it.
    expect(pageText()).toContain('Opened 1 place in the comparison.')
    expect(pageText()).toContain(STATE_AVERAGE_NOTE)
    // The collision, in both its forms, is absent from the page:
    // neither the substituted place's name nor its ZIP appears
    // anywhere (card, comparison table, or detail cards).
    expect(pageText()).not.toContain('Hawaiian Acres')
    expect(pageText()).not.toContain('96760')
    expect(pageText()).not.toContain('Opened 2 places in the comparison.')
    expect(pageText()).not.toContain(VIEWS_NOTE)
  }, 180_000)

  it('state-only shape: a Hawaii lookup opens no place and the note carries the average to the card', async () => {
    render(<App />)
    await ask(PROMPT_STATE_ONLY)
    expect(
      await waitFor(
        () => answerText().includes('Hawaii state average') && pageText().includes('No place was opened in the comparison for it.'),
      ),
    ).toBe(true)
    expect(answerText()).toContain('32.31')
    expect(pageText()).toContain(STATE_AVERAGE_NOTE)
    expect(pageText()).not.toContain('Hawaiian Acres')
    expect(pageText()).not.toContain('96760')
    // The false "nothing was opened" verdict must not fire beside
    // a working state-average card: nothing opened is the honest
    // outcome here, stated as such, not as a resolution failure.
    expect(pageText()).not.toContain(VIEWS_NOTE)
  }, 180_000)

  it('control: an ordinary two-place comparison still opens both places, with no state-average note', async () => {
    render(<App />)
    await ask(PROMPT_C1)
    expect(
      await waitFor(() => answerText().includes('East Honolulu') && pageText().includes('Opened')),
    ).toBe(true)
    expect(answerText()).toContain('$1,346')
    expect(answerText()).toContain('$2,946')
    expect(pageText()).toContain('Opened 2 places in the comparison.')
    expect(pageText()).toContain('96821')
    expect(pageText()).not.toContain('state average is shown on the answer card')
    expect(pageText()).not.toContain(VIEWS_NOTE)
  }, 180_000)

  it('control: a county comparison still behaves as P2c left it (members opened, no state-average note)', async () => {
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
    expect(answerText()).toContain('$1,600')
    expect(answerText()).toContain('$1,691')
    // 31 Denver County members + 18 Boulder County members.
    expect(pageText()).toContain('Opened 49 places in the comparison.')
    expect(pageText()).not.toContain('state average is shown on the answer card')
    expect(pageText()).not.toContain(VIEWS_NOTE)
  }, 180_000)
})
