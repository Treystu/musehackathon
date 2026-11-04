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
 * Cure round 3, defect 4 at the App seam (live probe on production
 * 4a44ce4, 2026-11-03): after the reader picked "Median age" in the
 * clarification panel, the completed answer stood under TWO stale
 * artifacts — the parse-time banner ("More detail is needed before
 * anything runs") and the execution note claiming a bound had
 * failed ("This bound cannot be set on the screening table...
 * Nothing was changed"), when no bound had been requested at all:
 * median age is rank-legal for Ask but has no sort preset on the
 * screening table, so executeIntentForPanel fell through to the
 * bound-failure copy. This pin mounts the real App, drives the
 * live traversal (ask -> clarification -> pick), and holds the
 * note to the truth: the answer above carries the screening; the
 * table cannot sort by that figure and is unchanged. The card
 * itself terminates at state level, oldest first (the full
 * terminal contract is pinned in live-fm9-round3.test.tsx).
 */

const Q1 = 'Which state has the oldest population?'

type Z = { age: number; ageM: number; pop: number }
const BY_ZCTA: Record<string, Z> = {
  '03901': { age: 55, ageM: 2, pop: 100 },
  '03902': { age: 53, ageM: 1, pop: 300 },
  '33001': { age: 45, ageM: 3, pop: 200 },
  '33002': { age: 47, ageM: 1, pop: 200 },
  '84001': { age: 30, ageM: 2, pop: 100 },
  '84002': { age: 34, ageM: 2, pop: 100 },
}
const ALL_ZCTAS = Object.keys(BY_ZCTA)
const FALLBACK_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const COUNTIES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-counties.json'), 'utf8')

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
      let queryText = ''
      try {
        const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '')
        const body = typeof raw === 'string' && raw ? JSON.parse(raw) : null
        queryText = (body as { queryText?: string } | null)?.queryText ?? ''
      } catch { /* fall through to the fallback intent */ }
      void queryText
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

describe('round 3 at the App seam: the completed run carries no stale chrome', () => {
  it('Q1 -> clarification -> Median age pick -> accurate execution note over a state-level answer', async () => {
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
      await waitFor(
        () =>
          pageText().includes('The answer above screens by median age') &&
          answerText().includes('Maine state average'),
      ),
    ).toBe(true)
    // The execution note tells the truth about the table.
    expect(pageText()).toContain('the screening table below cannot sort by that figure')
    // Neither stale artifact stands over the completed answer.
    expect(pageText()).not.toContain('This bound cannot be set on the screening table')
    expect(pageText()).not.toContain('Nothing was changed.')
    expect(pageText()).not.toContain('More detail is needed before anything runs')
    // The card terminates at state level, oldest first.
    const text = answerText()
    expect(text.indexOf('Maine state average')).toBeLessThan(text.indexOf('Florida state average'))
    expect(text.indexOf('Florida state average')).toBeLessThan(text.indexOf('Utah state average'))
    expect(text).toContain('not official Census state margins')
  }, 180_000)
})
