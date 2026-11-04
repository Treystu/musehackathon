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
 * Phase 5 conventions at the App seam (owner addendum, 2026-11-03
 * 23:14 HST): a researched run behaves like a normal AI session —
 * the preliminary answer appears while research is still running,
 * a Stop control stands in the ask pill for the whole run, and
 * stopping lands an honest terminal (the preliminary card with
 * the stopped line and its research-pending labels), never a
 * silent partial and never a hang. The research route here never
 * settles on its own; it rejects only when its fetch signal
 * aborts, so the whole sequence is driven by the Stop control.
 * Fixtures mirror app-philly-near.test.tsx (the frame's own App
 * pin); the question is the Philly specimen verbatim.
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

const PHILLY_INTENT = {
  mode: 'lookup',
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
        intent: queryText.toLowerCase().includes('philadelphia') ? PHILLY_INTENT : FALLBACK_INTENT,
      })
    }
    if (url.includes('/api/muse/research')) {
      // Never settles on its own: the run can only leave this
      // state through the abort signal (the Stop control) — the
      // exact discipline the pin exercises.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
        if (signal?.aborted) {
          reject(abortError())
          return
        }
        signal?.addEventListener('abort', () => reject(abortError()))
      })
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

function answerText(): string {
  return container.querySelector('[aria-label="Answer"]')?.textContent ?? ''
}
function pageText(): string {
  return container.textContent ?? ''
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  // Scoped to the ask form: the view tabs carry an "Ask" tab whose
  // label would otherwise collide with the pill's submit button.
  const form = container.querySelector('form')
  if (!form) return undefined
  return [...form.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
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

describe('Phase 5 conventions: preliminary, stop control, stopped terminal', () => {
  it('the preliminary renders while research hangs; Stop lands the labeled stopped terminal', async () => {
    render(<App />)
    await ask(QUESTION)

    // The preliminary stands while research is still in flight:
    // banner up, screened suburbs listed, schools pending.
    expect(await waitFor(() => answerText().includes('Preliminary answer'))).toBe(true)
    expect(answerText()).toContain('Bala Cynwyd')
    expect(answerText()).toContain('research pending')
    // The Stop control stands in the pill for the run's duration,
    // and the follow-up input stays available throughout.
    expect(buttonByText('Stop')).toBeDefined()
    expect(buttonByText('Ask')).toBeUndefined()
    expect(container.querySelector('#ask-input')).not.toBeNull()

    act(() => buttonByText('Stop')?.click())

    // The stopped terminal: the same card, banner gone, stopped
    // line on it, pending labels intact — an honest halted state.
    expect(await waitFor(() => answerText().includes('Stopped before research finished'))).toBe(true)
    expect(answerText()).not.toContain('the screened figures below are final')
    expect(answerText()).toContain('research pending')
    expect(answerText()).toContain('Bala Cynwyd')
    // The run is over: the Stop control leaves, Ask returns.
    expect(await waitFor(() => buttonByText('Ask') !== undefined)).toBe(true)
    expect(buttonByText('Stop')).toBeUndefined()
    expect(pageText()).not.toContain('could not be composed just now')
  }, 180_000)
})
