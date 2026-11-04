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
 * Cure round 4 — the state-level superlative computes correctly
 * but RENDERS the wrong list (parent probe on production da4e60e,
 * 2026-11-03 18:51–19:00 HST). Q1 "Which state has the oldest
 * population?" understood itself correctly ("screens whole country
 * by median age, highest first, answered at state level"), its
 * method notes described the state aggregation and disclosed the
 * territories — and the answer list rendered five Virgin Islands
 * ZIP places with no figures and no margins, "59 more places meet
 * the criteria", no state ranking, no winner. Q2 (youngest)
 * rendered the IDENTICAL list. The aggregates were right all
 * along (repro at the runner seam: Maine 53.5, Florida 46, Utah 32,
 * correctly weighted, correctly margined); they never reached the
 * rendered list, because stage 2c's failure branch kept a failed
 * average's member rows in the terminal set: the partitions ACS
 * publishes nothing for (AS/GU/MP/VI — ZCTAs the sweep carries as
 * absent rows, runSweep's own "roughly nineteen ZCTAs have no ACS
 * coverage") stayed as figure-less place rows ahead of every
 * formed average and falsified the ranking guard (every terminal
 * row a state aggregate), so no ranking applied. Rounds 2–3 could
 * not see it: their fixtures were small complete countries (every
 * state measurable) and their App stub returned figures for every
 * ZCTA including the territories. These pins therefore (a) drive
 * the FULL App traversal on a production-shaped stub — the Census
 * stub returns NO row for the no-coverage ZCTAs, so the loader
 * materializes them as absent rows exactly as production does —
 * for both superlative directions, asserting the rendered list;
 * and (b) pin the full ranked list + conclusion at the runner seam
 * over the live-shaped rows.
 */

const Q1 = 'Which state has the oldest population?'
const Q2 = 'Which state has the youngest population?'

/* ------------------------------------------------------------------ */
/* Runner-seam fixture: measurable states + absent territory rows      */
/* ------------------------------------------------------------------ */

const SWEEP_MEDIAN_AGE: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_age'],
  filters: [],
  clarificationNeeded: false,
}

const MEASURABLE: AreaRow[] = [
  { zcta: '03901', name: 'Kittery, ME', metrics: { median_age: 55, population: 100 }, moes: { median_age: 2 } },
  { zcta: '03902', name: 'York, ME', metrics: { median_age: 53, population: 300 }, moes: { median_age: 1 } },
  { zcta: '33001', name: 'Key West, FL', metrics: { median_age: 45, population: 200 }, moes: { median_age: 3 } },
  { zcta: '33002', name: 'Marathon, FL', metrics: { median_age: 47, population: 200 }, moes: { median_age: 1 } },
  { zcta: '84001', name: 'Provo, UT', metrics: { median_age: 30, population: 100 }, moes: { median_age: 2 } },
  { zcta: '84002', name: 'Orem, UT', metrics: { median_age: 34, population: 100 }, moes: { median_age: 2 } },
]

// Absent rows: metrics/moes empty, exactly as runSweep adds them
// for ZCTAs the Census API returns nothing for.
const ABSENT: AreaRow[] = [
  { zcta: '00802', name: 'Charlotte Amalie, VI', metrics: {}, moes: {} },
  { zcta: '00820', name: 'Christiansted, VI', metrics: {}, moes: {} },
  { zcta: '00830', name: 'Charlotte Amalie West, VI', metrics: {}, moes: {} },
  { zcta: '00840', name: 'Frederiksted, VI', metrics: {}, moes: {} },
  { zcta: '00850', name: 'Kingshill, VI', metrics: {}, moes: {} },
  { zcta: '00851', name: 'Charlotte Amalie East, VI', metrics: {}, moes: {} },
  { zcta: '96799', name: 'Pago Pago, AS', metrics: {}, moes: {} },
  { zcta: '96910', name: 'Hagatna, GU', metrics: {}, moes: {} },
  { zcta: '96952', name: 'Saipan, MP', metrics: {}, moes: {} },
]

const LIVE_SHAPED_ROWS = [...MEASURABLE, ...ABSENT]

const LIVE_SHAPED_INDEX = new PlaceIndex(
  new Map(
    LIVE_SHAPED_ROWS.map((row) => {
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
    rows: LIVE_SHAPED_ROWS,
    resolved: resolveAnswerGeographies(SWEEP_MEDIAN_AGE, LIVE_SHAPED_INDEX),
    provider: createStubProvider(),
    research: false,
    placeIndex: LIVE_SHAPED_INDEX,
    stack: false,
  })
}

describe('round 4 at the runner seam: the ranked aggregates ARE the list', () => {
  it('oldest: ranked state aggregates only, figures + margins, winner named, territories only in the disclosure', async () => {
    const answer = await stateTerminal(Q1)
    expect(answer?.status).toBe('verified')
    expect(answer?.geographyLevel).toBe('state')
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Maine state average',
      'Florida state average',
      'Utah state average',
    ])
    const figures = answer!.places.map((p) => p.figures.find((f) => f.key === 'median_age')!)
    expect(figures.map((f) => f.value)).toEqual([53.5, 46, 32])
    expect(figures[0]!.marginOfError).toBeCloseTo(Math.sqrt(1.75), 10)
    expect(figures[1]!.marginOfError).toBeCloseTo(Math.sqrt(5), 10)
    expect(figures[2]!.marginOfError).toBeCloseTo(2, 10)
    expect(figures.every((f) => f.marginApproximate === true)).toBe(true)
    // The winner's band (53.5 ± 1.32) clears Florida's (46 ± 2.24)
    // and Utah's (32 ± 2), so the conclusion asserts the winner.
    expect(answer?.summary).toContain(
      'Maine state average has the highest median age of the states shown.',
    )
    // The failed partitions are carried ONLY by the disclosure:
    // no member place from them stands in the list.
    const names = answer!.places.map((p) => p.name).join(' ')
    for (const member of ['Charlotte Amalie', 'Christiansted', 'Frederiksted', 'Kingshill', 'Pago Pago', 'Hagatna', 'Saipan']) {
      expect(names).not.toContain(member)
    }
    const disclosures = (answer?.geographyDisclosures ?? []).join('\n')
    for (const label of ['Virgin Islands', 'American Samoa', 'Guam', 'Northern Mariana Islands']) {
      expect(disclosures).toContain(`${label} was named as a state average`)
    }
  })

  it('youngest: the rendered order flips end to end and the winner flips with it', async () => {
    const answer = await stateTerminal(Q2)
    expect(answer?.status).toBe('verified')
    expect(answer?.geographyLevel).toBe('state')
    expect(answer?.places.map((p) => p.name)).toEqual([
      'Utah state average',
      'Florida state average',
      'Maine state average',
    ])
    const figures = answer!.places.map((p) => p.figures.find((f) => f.key === 'median_age')!)
    expect(figures.map((f) => f.value)).toEqual([32, 46, 53.5])
    expect(answer?.summary).toContain(
      'Utah state average has the lowest median age of the states shown.',
    )
  })
})

/* ------------------------------------------------------------------ */
/* Full App traversal on the production-shaped stub                    */
/* ------------------------------------------------------------------ */

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')

// The no-coverage set, derived from the shipped place index: the
// four territory codes ACS publishes no ZCTA estimates for. In the
// shipped payload that is 17 ZCTAs (AS 1, GU 7, MP 3, VI 6).
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
      // The sweep enumerates the country's ZCTAs from TIGERweb
      // (listAllZctas): answer its window queries from the shipped
      // place index, in the ArcGIS JSON shape it parses. Geometry
      // queries (the answer map) get an empty collection — the map
      // is not under test here and settles to its failure line.
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
      // Production coverage shape: a no-coverage ZCTA gets NO row
      // in the response at all — the sweep loader then carries it
      // as an absent (figure-less) row, as it does live.
      const rows = zctas
        .filter((z) => !NO_COVERAGE_ZCTAS.has(z))
        .map((z) => {
          const rec = BY_ZCTA[z] ?? { age: 40, ageM: 5, pop: 1000 }
          return header.map((h) => {
            if (h === 'NAME') return `ZCTA5 ${z}`
            if (h === 'zip code tabulation area') return z
            if (h === VARS.medianAge) return String(rec.age)
            if (h === VARS.medianAge.replace(/E$/, 'M')) return String(rec.ageM)
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

async function askAndPickMedianAge(question: string) {
  render(<App />)
  await ask(question)
  expect(
    await waitFor(() => container.querySelector('[aria-label="Clarify the request"]') !== null),
  ).toBe(true)
  const section = container.querySelector('[aria-label="Clarify the request"]') as HTMLElement
  const button = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Median age')
  if (!button) throw new Error('Median age pick not offered')
  act(() => button.click())
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

describe('round 4 at the App seam: the rendered list is the ranked state aggregates', () => {
  it('the no-coverage derivation matches the shipped payload (17 territory ZCTAs)', () => {
    expect(NO_COVERAGE_ZCTAS.size).toBe(17)
    expect(NO_COVERAGE_ZCTAS.has('00802')).toBe(true)
    expect(NO_COVERAGE_ZCTAS.has('96799')).toBe(true)
  })

  it('Q1 oldest: Maine heads a 52-state ranked list; territory places never render; the disclosure carries them', async () => {
    await askAndPickMedianAge(Q1)
    expect(
      await waitFor(() => answerText().includes('Maine state average')),
    ).toBe(true)
    const text = answerText()
    // The terminal set is exactly the 52 formed aggregates (56
    // partitions minus AS/GU/MP/VI): the card shows 10 and counts
    // the rest — the pre-cure terminal counted 69 (52 + 17 raw
    // territory rows).
    expect(text).toContain('42 more places meet the stated criteria')
    // Head of the rendered list: Maine (its two measured ZCTAs
    // lift its weighted mean a hair over the uniform 40 of the
    // default states), then Florida.
    expect(text.indexOf('Maine state average')).toBeLessThan(text.indexOf('Florida state average'))
    // Figures with margins render on the card.
    expect(text).toContain('±')
    expect(text).toContain('approx.')
    expect(pageText()).toContain('not official Census state margins')
    // The conclusion names the winner. On this stub's data every
    // aggregate margin is wide (the uniform defaults), so the
    // bands overlap and the conclusion states the order — the
    // strong form is pinned at the runner seam above, where the
    // bands carry it. The noun is "states and other Census
    // geographies" (regression battery 2026-11-04, R-E): this
    // traversal's ranked set carries the District of Columbia
    // aggregate, so the lead names the set it actually ranks.
    expect(text).toContain('Maine state average heads the states and other Census geographies ordered by median age, highest first.')
    // No territory member place renders anywhere in the answer;
    // the territories are present only as the disclosure.
    for (const member of ['Charlotte Amalie', 'Christiansted', 'Frederiksted', 'Kingshill', 'Pago Pago', 'Hagatna', 'Saipan']) {
      expect(text).not.toContain(member)
    }
    expect(pageText()).toContain('Virgin Islands was named as a state average')
  }, 180_000)

  it('Q2 youngest: the same traversal renders the flipped list — Utah heads it, Maine is last', async () => {
    await askAndPickMedianAge(Q2)
    expect(
      await waitFor(() => answerText().includes('Utah state average')),
    ).toBe(true)
    const text = answerText()
    expect(text).toContain('42 more places meet the stated criteria')
    // Utah's measured ZCTAs pull its mean just under the uniform
    // 40, so it heads the ascending list; Maine (just over 40)
    // sits beyond the rendered head — the pair's orders differ at
    // every position the two cards share, which is the direction
    // acceptance.
    expect(text).toContain('Utah state average heads the states and other Census geographies ordered by median age, lowest first.')
    expect(text.indexOf('Utah state average')).toBeLessThan(text.indexOf('Alabama state average'))
    expect(text).not.toContain('Maine state average')
    for (const member of ['Charlotte Amalie', 'Christiansted', 'Frederiksted', 'Kingshill', 'Pago Pago', 'Hagatna', 'Saipan']) {
      expect(text).not.toContain(member)
    }
    expect(pageText()).toContain('Virgin Islands was named as a state average')
  }, 180_000)
})
