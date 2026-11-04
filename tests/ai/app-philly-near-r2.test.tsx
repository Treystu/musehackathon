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
 * Near-frame round 2 at the App seam (measured live on production
 * 6151d0c, 2026-11-03): round 1's App pin fed the specimen a lookup
 * parse and the frame engaged; the live parse for the same words
 * came back similarity, and the whole run routed away — execution
 * opened the similar-ZIP search on the anchor's own ZIP and a
 * standalone web summary stood as the answer. This pin feeds the
 * App the LIVE parse shape (similarity) and holds the full
 * traversal: the accept seam's re-route registers the question
 * with the answer layer, the frame engages (centroids load, scope
 * widens, suburbs screen against the baseline), the preliminary
 * card stands while research is still in flight, and the terminal
 * is the frame's screened answer — never the similarity view.
 *
 * Timing (Phase 5's method, RESEARCHED-CLASS-PERF.md): the
 * research route is scripted to 600 ms so the staging gap is
 * visible in-harness; time-to-preliminary and time-to-completion
 * are measured from the submit and logged for the seat record.
 * The numbers are harness-relative (stubbed network, fixture
 * scale) — the structure is the assertion: the preliminary lands
 * on the deterministic side of the research stage, the terminal
 * after it.
 */

const QUESTION =
  'where near philadelphia has good schools and lower cost of living, within 20 miles (as compared to philadelphia itself).'

type Z = { rent: number; hv: number; pop: number }
const BY_ZCTA: Record<string, Z> = {
  '19102': { rent: 2000, hv: 400000, pop: 1000 },
  '19103': { rent: 2000, hv: 400000, pop: 1000 },
  '19104': { rent: 2000, hv: 400000, pop: 1000 },
  '19004': { rent: 1200, hv: 520000, pop: 8000 },
  '19082': { rent: 1350, hv: 310000, pop: 9000 },
  '19406': { rent: 2600, hv: 480000, pop: 7000 },
  '08002': { rent: 1100, hv: 350000, pop: 5000 },
  '08103': { rent: 950, hv: 150000, pop: 5000 },
}
const ALL_ZCTAS = Object.keys(BY_ZCTA)

function figureFor(zcta: string): Z {
  const exact = BY_ZCTA[zcta]
  if (exact) return exact
  if (zcta.startsWith('191')) return { rent: 2000, hv: 400000, pop: 1000 }
  return { rent: 1000, hv: 300000, pop: 1000 }
}

/** The parse shape the live route returned for the specimen. */
const SIMILARITY_INTENT = {
  mode: 'similarity',
  geographies: ['Philadelphia, PA'],
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}
const FALLBACK_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const RESEARCH_PROSE = [
  'Bala Cynwyd, PA is served by the Lower Merion School District, whose schools are rated among the strongest in the state.',
  'Schools in Philadelphia, Pennsylvania (Elementary, Middle High Schools) Best Public Schools in Bala Cynwyd, PA',
].join(' ')
const RESEARCH_SOURCES = [
  { title: 'Schools in Philadelphia, Pennsylvania (Elementary, Middle and High Schools)', url: 'https://example.org/philly-schools' },
  { title: 'Best Public Schools in Bala Cynwyd, PA (2026-27)', url: 'https://example.org/bala-schools' },
  { title: 'Lower Merion School District profile', url: 'https://example.org/lmsd' },
]
const RESEARCH_DELAY_MS = 600

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')
const CENTROIDS_BIN = readFileSync(join(process.cwd(), 'public/map/zcta-centroids.bin'))

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
    if (url.includes('/map/zcta-centroids.bin'))
      return new Response(new Uint8Array(CENTROIDS_BIN), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    if (url.includes('tigerweb.geo.census.gov')) {
      const where = new URL(url).searchParams.get('where') ?? ''
      const bounds = [...where.matchAll(/'(\d{5})'/g)].map((m) => m[1]!)
      const lo = bounds[0] ?? '00000'
      const hi = bounds[1] ?? '99999'
      const features = ALL_ZCTAS.filter((z) => z >= lo && z <= hi).map((z) => ({
        attributes: { ZCTA5: z },
      }))
      return jsonResponse(200, { features })
    }
    if (url.includes('api.census.gov')) {
      const params = new URL(url).searchParams
      const vars = (params.get('get') ?? '').split(',').filter(Boolean)
      const geo = params.get('for') ?? ''
      const zctas = (geo.split(':')[1] ?? '').split(',').filter(Boolean)
      const header = [...vars, 'zip code tabulation area']
      const rows = zctas.map((z) => {
        const rec = figureFor(z)
        return header.map((h) => {
          if (h === 'NAME') return `ZCTA5 ${z}`
          if (h === 'zip code tabulation area') return z
          if (h === VARS.medianGrossRent) return String(rec.rent)
          if (h === VARS.medianHomeValue) return String(rec.hv)
          if (h === VARS.population) return String(rec.pop)
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
      return jsonResponse(200, {
        intent: queryText.toLowerCase().includes('philadelphia') ? SIMILARITY_INTENT : FALLBACK_INTENT,
      })
    }
    if (url.includes('/api/muse/research')) {
      await new Promise((resolve) => setTimeout(resolve, RESEARCH_DELAY_MS))
      return jsonResponse(200, { prose: RESEARCH_PROSE, sources: RESEARCH_SOURCES })
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

function answerText(): string {
  return container.querySelector('[aria-label="Answer"]')?.textContent ?? ''
}
function pageText(): string {
  return container.textContent ?? ''
}

/** Poll on a short clock, stamping when each predicate first holds. */
async function stampWhen(
  stamps: Map<string, number>,
  startedAt: number,
  budgetMs = 90000,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const now = Date.now() - startedAt
    if (!stamps.has('preliminary') && answerText().includes('research pending')) {
      stamps.set('preliminary', now)
    }
    if (!stamps.has('complete') && pageText().includes('Complete —')) {
      stamps.set('complete', now)
    }
    if (stamps.has('preliminary') && stamps.has('complete')) return
    if (Date.now() > deadline) return
  }
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

describe('the near Philadelphia specimen under its live (similarity) parse', () => {
  it('terminates in the near-frame screened answer, preliminary first', async () => {
    render(<App />)
    const startedAt = Date.now()
    await ask(QUESTION)
    const stamps = new Map<string, number>()
    await stampWhen(stamps, startedAt)
    const preliminaryMs = stamps.get('preliminary')
    const completeMs = stamps.get('complete')
    console.info(
      `[philly-near-r2 timing] time-to-preliminary=${preliminaryMs ?? 'unobserved'}ms ` +
        `time-to-completion=${completeMs ?? 'unobserved'}ms (research scripted at ${RESEARCH_DELAY_MS}ms)`,
    )
    // The staging structure: the screened preliminary stands while
    // research is still in flight; the terminal replaces it after.
    expect(preliminaryMs).toBeDefined()
    expect(completeMs).toBeDefined()
    expect(preliminaryMs!).toBeLessThan(completeMs!)

    const text = answerText()
    // The frame's screened suburbs, as in round 1's lookup traversal.
    expect(text).toContain('Bala Cynwyd')
    expect(text).toContain('Millbourne')
    expect(text).toContain('Cherry Hill')
    expect(text).not.toContain('King of Prussia')
    // The reference disclosure and the geography-accounted frame entry.
    expect(text).toContain('is the comparison reference for this question')
    expect(text).toContain('ZIP-area centroid distance')
    // The genuine per-place finding lands at the terminal; the
    // garbled title concatenation never renders.
    expect(text).toContain('Lower Merion School District')
    expect(text).not.toContain('Elementary, Middle High Schools')
    // The routing itself: the re-route is disclosed in the panel
    // note, and the similarity view was never opened.
    expect(pageText()).toContain('This screens the places near Philadelphia, PA')
    expect(pageText()).not.toContain('Opened similar-ZIP search')
  }, 180_000)
})
