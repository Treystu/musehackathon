// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import {
  decodePlaces,
  resetPlaceIndexCache,
} from '../../src/core/zcta-place-index'
import { resetCountyIndexCache } from '../../src/core/zcta-county-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { VARS, type AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { composeAnswerForRequest, resolveAnswerGeographies } from '../../src/ui/ai/answer-runner'
import { PlaceIndex } from '../../src/core/zcta-place-index'

/**
 * Cure round 5 — the final FM-9 item: live state-average cards
 * render NO margins, while the staged path renders them and the
 * method note claims them (parent probes on production eab3d37,
 * 2026-11-03 19:29–20:53 HST: "Maine state average — 427 ZIP
 * areas — MEDIAN AGE — 45", zero of 52 state entries carrying a
 * margin, under the note "...with margins that are
 * population-weighted approximations, not official Census state
 * margins").
 *
 * The seam is NOT in the aggregation path. First-hand, on this
 * tree: the screen fetch requests B01002_001M (round 3) and the
 * parser lands it on the row (screen-median-age-margin.test.ts);
 * the combiner (county-aggregate.ts) combines the margins of the
 * members that HAVE them, weights renormalised over those members;
 * stage 2c, compose and the card all propagate the result (round
 * 4's pins, and the R23 staged capture's "42±1 approx."). What
 * live rows actually carry is decided one layer earlier, by the
 * sweep cache: chunks are keyed by SWEEP_VERSION, and round 3
 * changed the fetched variable set WITHOUT moving the stamp —
 * it stayed 'acs5:2023:screen:v7-honest-labels', the stamp the
 * cache's own contract (src/core/cache.ts, src/core/sweep/
 * runSweep.ts) says must move when the variable set changes.
 * Every browser that cached chunks under v7 with a pre-round-3
 * build — the probe browser, and every returning visitor since —
 * is served those parsed rows verbatim on every later visit: the
 * median-age margin column was never in them, a cache hit bypasses
 * fetch and parse, and sanitiseAreaRow cannot restore a column
 * that was never fetched. The combiner then finds zero
 * margin-carrying members for every state and the card renders
 * bare integers. Fresh sessions fetch the margin and render it —
 * exactly the live/staged split the probes recorded.
 *
 * Rounds 3–4 were structurally blind to it: jsdom has no
 * IndexedDB, so the versioned chunk cache is inert in-suite and
 * every test sweep fetches fresh through the stub; and round 4's
 * fixtures carried complete margins besides. These pins therefore
 * hold (a) the stamp discipline at the seam the cure acts on
 * (screen-median-age-margin.test.ts: while the screen requests
 * the margin variable, the stamp is not the v7 stamp margin-less
 * chunks were written under), (b) the combiner + terminal over
 * LIVE-LIKE partial margins — members whose margin cell the
 * publisher returned as a missing-value sentinel parse to no
 * margin on the row, and a state must still combine a margin
 * from the members that carry one, while a state with no usable
 * member margin renders bare rather than inventing one — and
 * (c) the full App traversal on a stub that returns the sentinel
 * for the margin cell of half the country's ZCTAs.
 */

const Q1 = 'Which state has the oldest population?'
const Q2 = 'Which state has the youngest population?'

/* ------------------------------------------------------------------ */
/* Runner-seam fixture: partial, absent and complete margin coverage   */
/* ------------------------------------------------------------------ */

const SWEEP_MEDIAN_AGE: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_age'],
  filters: [],
  clarificationNeeded: false,
}

// Live-shaped rows: a member whose margin cell the publisher
// returned as a sentinel carries the value and the population
// weight but NO median_age entry in moes — exactly what
// areaRowFromRaw produces for such a cell (toNum nulls the
// sentinel, so the margin is simply absent from the row).
const PARTIAL_ROWS: AreaRow[] = [
  // Maine — partial coverage: one member carries a margin, the
  // other (the heavier one) does not.
  { zcta: '03901', name: 'Kittery, ME', metrics: { median_age: 55, population: 100 }, moes: { median_age: 2 } },
  { zcta: '03902', name: 'York, ME', metrics: { median_age: 53, population: 300 }, moes: {} },
  // Vermont — no usable member margins at all.
  { zcta: '05801', name: 'Barre, VT', metrics: { median_age: 48, population: 100 }, moes: {} },
  { zcta: '05802', name: 'Montpelier, VT', metrics: { median_age: 50, population: 100 }, moes: {} },
  // Florida — complete coverage (round 4's members).
  { zcta: '33001', name: 'Key West, FL', metrics: { median_age: 45, population: 200 }, moes: { median_age: 3 } },
  { zcta: '33002', name: 'Marathon, FL', metrics: { median_age: 47, population: 200 }, moes: { median_age: 1 } },
  // Utah — complete coverage (round 4's members).
  { zcta: '84001', name: 'Provo, UT', metrics: { median_age: 30, population: 100 }, moes: { median_age: 2 } },
  { zcta: '84002', name: 'Orem, UT', metrics: { median_age: 34, population: 100 }, moes: { median_age: 2 } },
  // Absent rows: metrics/moes empty, exactly as runSweep adds
  // them for ZCTAs the Census API returns nothing for.
  { zcta: '00802', name: 'Charlotte Amalie, VI', metrics: {}, moes: {} },
  { zcta: '00820', name: 'Christiansted, VI', metrics: {}, moes: {} },
  { zcta: '96799', name: 'Pago Pago, AS', metrics: {}, moes: {} },
  { zcta: '96910', name: 'Hagatna, GU', metrics: {}, moes: {} },
  { zcta: '96952', name: 'Saipan, MP', metrics: {}, moes: {} },
]

const PARTIAL_INDEX = new PlaceIndex(
  new Map(
    PARTIAL_ROWS.map((row) => {
      const [town, state] = row.name.split(', ') as [string, string]
      return [
        row.zcta,
        { zip: row.zcta, censusName: `${town} city`, displayName: town, state, isCity: true, incorporated: true },
      ] as const
    }),
  ),
  [],
)

async function stateTerminal(queryText: string) {
  return composeAnswerForRequest({
    intent: SWEEP_MEDIAN_AGE,
    queryText,
    rows: PARTIAL_ROWS,
    resolved: resolveAnswerGeographies(SWEEP_MEDIAN_AGE, PARTIAL_INDEX),
    provider: createStubProvider(),
    research: false,
    placeIndex: PARTIAL_INDEX,
    stack: false,
  })
}

describe('round 5 at the runner seam: live-like partial margins still combine', () => {
  it('oldest: a partially covered state combines a margin from the members that carry one; an uncovered state renders bare', async () => {
    const answer = await stateTerminal(Q1)
    expect(answer?.status).toBe('verified')
    expect(answer?.geographyLevel).toBe('state')
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Maine state average',
      'Vermont state average',
      'Florida state average',
      'Utah state average',
    ])
    const figures = answer!.places.map((p) => p.figures.find((f) => f.key === 'median_age')!)
    expect(figures.map((f) => f.value)).toEqual([53.5, 49, 46, 32])
    // Maine: the combined margin is the population-weighted RMS
    // over the members that carry one, weights renormalised over
    // those members — the single carrying member (margin 2,
    // population 100) gives exactly 2, NOT a null over the whole
    // partition and NOT diluted by the uncovered member's weight.
    expect(figures[0]!.marginOfError).toBeCloseTo(2, 10)
    expect(figures[0]!.marginApproximate).toBe(true)
    // Vermont: no member carries a usable margin, so no margin is
    // shown — the disclosure stands, nothing is invented.
    expect(figures[1]!.marginOfError).toBeUndefined()
    expect(figures[1]!.marginApproximate).not.toBe(true)
    // Florida / Utah: complete coverage, round 4's combined values.
    expect(figures[2]!.marginOfError).toBeCloseTo(Math.sqrt(5), 10)
    expect(figures[2]!.marginApproximate).toBe(true)
    expect(figures[3]!.marginOfError).toBeCloseTo(2, 10)
    expect(figures[3]!.marginApproximate).toBe(true)
    // The winner's band (53.5 ± 2) clears Vermont's bare value
    // (49) and every other band, so the strong-form conclusion
    // stands with partial coverage in the field.
    expect(answer?.summary).toContain(
      'Maine state average has the highest median age of the states shown.',
    )
    const disclosures = (answer?.geographyDisclosures ?? []).join('\n')
    for (const label of ['Virgin Islands', 'American Samoa', 'Guam', 'Northern Mariana Islands']) {
      expect(disclosures).toContain(`${label} was named as a state average`)
    }
  })

  it('youngest: the flipped ranking carries the same partial margins', async () => {
    const answer = await stateTerminal(Q2)
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Utah state average',
      'Florida state average',
      'Vermont state average',
      'Maine state average',
    ])
    const figures = answer!.places.map((p) => p.figures.find((f) => f.key === 'median_age')!)
    expect(figures.map((f) => f.value)).toEqual([32, 46, 49, 53.5])
    expect(figures[0]!.marginOfError).toBeCloseTo(2, 10)
    expect(figures[2]!.marginOfError).toBeUndefined()
    expect(figures[3]!.marginOfError).toBeCloseTo(2, 10)
    expect(answer?.summary).toContain(
      'Utah state average has the lowest median age of the states shown.',
    )
  })
})

/* ------------------------------------------------------------------ */
/* Full App traversal: the margin cell is a sentinel for half the map  */
/* ------------------------------------------------------------------ */

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')

const NO_COVERAGE_ZCTAS: ReadonlySet<string> = (() => {
  const { byZip } = decodePlaces(JSON.parse(PLACES_JSON))
  const set = new Set<string>()
  for (const [zip, record] of byZip) {
    if (record.state === 'AS' || record.state === 'GU' || record.state === 'MP' || record.state === 'VI') {
      set.add(zip)
    }
  }
  return set
})()

type Z = { age: number; ageM: number; pop: number }
const BY_ZCTA: Record<string, Z> = {
  '03901': { age: 55, ageM: 2, pop: 100 },
  '03902': { age: 53, ageM: 1, pop: 300 },
  '33001': { age: 45, ageM: 3, pop: 200 },
  '33002': { age: 47, ageM: 1, pop: 200 },
  '84001': { age: 30, ageM: 2, pop: 100 },
  '84002': { age: 34, ageM: 2, pop: 100 },
}
const FALLBACK_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

// Live-like margin coverage: the publisher returns the
// missing-value sentinel for the median-age margin cell of every
// even-ending ZCTA (and 03902 besides, so Maine itself is a
// partially covered state: 03901 carries its margin, 03902 does
// not). The parser nulls the sentinel, so those rows reach the
// aggregation with no margin — the shape the live cache seam hid
// behind complete-margin fixtures in round 4.
function marginIsSentinel(zcta: string): boolean {
  return Number(zcta.slice(-1)) % 2 === 0 || zcta === '03902'
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch() {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json'))
      return new Response(PLACES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/map/zcta-counties.json'))
      return new Response(COUNTIES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('tigerweb.geo.census.gov')) {
      if (url.includes('returnGeometry=false')) {
        const { byZip } = decodePlaces(JSON.parse(PLACES_JSON))
        const where = new URL(url).searchParams.get('where') ?? ''
        const bounds = [...where.matchAll(/'(\d{5})'/g)].map((m) => m[1]!)
        const lo = bounds[0] ?? '00000'
        const hi = bounds[1] ?? '99999'
        const features = [...byZip.keys()]
          .filter((z) => z >= lo && z <= hi)
          .map((z) => ({ attributes: { ZCTA5: z } }))
        return jsonResponse(200, { features })
      }
      return jsonResponse(200, { type: 'FeatureCollection', features: [] })
    }
    if (url.includes('api.census.gov')) {
      const params = new URL(url).searchParams
      const vars = (params.get('get') ?? '').split(',').filter(Boolean)
      const geo = params.get('for') ?? ''
      const zctas = (geo.split(':')[1] ?? '').split(',').filter(Boolean)
      const header = [...vars, 'zip code tabulation area']
      const rows = zctas
        .filter((z) => !NO_COVERAGE_ZCTAS.has(z))
        .map((z) => {
          const rec = BY_ZCTA[z] ?? { age: 40, ageM: 5, pop: 1000 }
          return header.map((h) => {
            if (h === 'NAME') return `ZCTA5 ${z}`
            if (h === 'zip code tabulation area') return z
            if (h === VARS.medianAge) return String(rec.age)
            if (h === VARS.medianAge.replace(/E$/, 'M'))
              return marginIsSentinel(z) ? '-666666666' : String(rec.ageM)
            if (h === VARS.population) return String(rec.pop)
            if (h.endsWith('M')) return '10'
            return '1000'
          })
        })
      return jsonResponse(200, [header, ...rows])
    }
    if (url.includes('/api/muse/intent')) {
      void init
      return jsonResponse(200, { intent: FALLBACK_INTENT })
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

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function ask(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function waitFor(predicate: () => boolean, budgetMs = 90000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
      ok = predicate()
    })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string {
  return container.textContent ?? ''
}
function answerText(): string {
  return container.querySelector('[aria-label="Answer"]')?.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', window.location.pathname)
  resetBudget()
  _resetPacing()
  resetPlaceIndexCache()
  resetCountyIndexCache()
  ;(globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL] = {
    CENSUS_APP_KEY: 'fake-shared-key-for-tests',
  }
  installFetch()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  resetPlaceIndexCache()
  resetCountyIndexCache()
  delete (globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL]
})

describe('round 5 at the App seam: partial margin coverage still renders margins', () => {
  it('Q1 oldest: with half the margin cells sentinel, the rendered state card still shows ± approx. figures', async () => {
    render(<App />)
    await ask(Q1)
    expect(
      await waitFor(() => container.querySelector('[aria-label="Clarify the request"]') !== null),
    ).toBe(true)
    const section = container.querySelector('[aria-label="Clarify the request"]') as HTMLElement
    const button = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Median age')
    if (!button) throw new Error('Median age pick not offered')
    act(() => button.click())

    expect(
      await waitFor(() => answerText().includes('Maine state average')),
    ).toBe(true)
    const text = answerText()
    expect(text).toContain('42 more places meet the stated criteria')
    expect(text.indexOf('Maine state average')).toBeLessThan(text.indexOf('Florida state average'))
    // Partial coverage does not strip the card of margins: every
    // state keeps the members whose margin cells the publisher
    // filled, and the combined approximation renders.
    expect(text).toContain('±')
    expect(text).toContain('approx.')
    expect(pageText()).toContain('not official Census state margins')
    // The lead's noun matches the ranked set's contents
    // (regression battery 2026-11-04, R-E): the District of
    // Columbia aggregate ranks inside this set.
    expect(text).toContain('Maine state average heads the states and other Census geographies ordered by median age, highest first.')
  }, 180_000)
})
