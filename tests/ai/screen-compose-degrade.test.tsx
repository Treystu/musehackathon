// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import { resetPlaceIndexCache } from '../../src/core/zcta-place-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { SCREEN_VARS } from '../../src/core/plugins/acs'

/**
 * The screen-path compose throw, on the REAL data path (owner live
 * finding, 2026-11-02 ~18:03 HST): "Where is the best schools and
 * lowest cost of living in Arkansas?" — the surface narrated the AR
 * rent screen (the screen succeeded; screened rows existed) and the
 * Answer block then rendered the bare compose-failed note.
 * Diagnosis (drive-scratch RESULTS): the question decomposes to
 * exactly one researched pass (schools; cost of living decomposes
 * onto median_gross_rent), and researchPerCriterion's zero-success
 * rethrow — the research-first path's honest terminal — propagated
 * out of the screen path's research stage and discarded the
 * completed Census screen. The harness is flexible-live-path's:
 * the real App, the real place index from disk, the real sweep
 * machinery — only the network is stubbed, with the research route
 * failing every call (the provider_down window the owner hit).
 */

const OWNER_QUESTION = 'Where is the best schools and lowest cost of living in Arkansas?'
const COMPOSE_FAILED_NOTE = 'could not be composed just now'
const LOOKUP_FAILED_LINE = 'The research lookup for this criterion did not return'

const AR_SCREEN_INTENT = {
  mode: 'sweep_filter',
  geographies: ['AR'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const EXTERNAL_ONLY_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const TEST_ZCTAS = [
  '02101', '10001', '30301', '40771', '55401', '60601',
  '71601', '71901', '72201', '72701',
  '78701', '90210', '96720', '96749', '96778', '96821',
]
const RENT_BY_ZCTA: Record<string, number> = {
  '71601': 750,
  '71901': 890,
  '72201': 1050,
  '72701': 1150,
  '96720': 1450,
}

const PLACES_JSON = readFileSync(
  join(process.cwd(), 'public/map/zcta-places.json'),
  'utf8',
)

const NAMED_SCHOOLS_BODY = {
  prose:
    'Pine Bluff, AR schools are rated above the state average in the cited directory. ' +
    'Hot Springs, AR schools are described in the cited guide.',
  sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
}

interface FetchLog {
  research: number
  researchStatuses: number[]
  flexible: number
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetchOptions {
  /** 'down' fails every research call (provider_down); 'named' returns the schools findings. */
  researchMode?: 'down' | 'named'
}

function installFetch(log: FetchLog, options: FetchOptions = {}) {
  const handler = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json')) {
      return new Response(PLACES_JSON, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('tigerweb.geo.census.gov')) {
      const where = new URL(url).searchParams.get('where') ?? ''
      const bounds = [...where.matchAll(/'(\d{5})'/g)].map((m) => m[1]!)
      const lo = bounds[0] ?? '00000'
      const hi = bounds[1] ?? '99999'
      const features = TEST_ZCTAS.filter((z) => z >= lo && z <= hi).map((z) => ({
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
      const rows = zctas.map((z) =>
        header.map((h) => {
          if (h === 'NAME') return `ZCTA5 ${z}`
          if (h === 'zip code tabulation area') return z
          if (h === SCREEN_VARS[0]) return String(RENT_BY_ZCTA[z] ?? 1000)
          if (h.endsWith('M')) return '10'
          return '1000'
        }),
      )
      return jsonResponse(200, [header, ...rows])
    }
    if (url.includes('/api/muse/intent')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        queryText?: string
      }
      const intent = (body.queryText ?? '').includes('Arkansas')
        ? AR_SCREEN_INTENT
        : EXTERNAL_ONLY_INTENT
      return jsonResponse(200, { intent })
    }
    if (url.includes('/api/muse/research')) {
      log.research += 1
      const fail = (options.researchMode ?? 'down') === 'down'
      log.researchStatuses.push(fail ? 500 : 200)
      if (fail) return jsonResponse(500, { error: 'provider_down' })
      return jsonResponse(200, NAMED_SCHOOLS_BODY)
    }
    if (url.includes('/api/muse/plan')) {
      return jsonResponse(200, { verdict: 'sound', objections: [] })
    }
    if (url.includes('/api/muse/verify')) {
      return jsonResponse(200, { verdict: 'verified', concerns: [] })
    }
    if (url.includes('/api/muse/jev')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        set?: string
        questions?: { id: string; type: string }[]
      }
      if (body.set === 'J-BRANCH') {
        return jsonResponse(200, {
          answers: {
            'branch-exists': { type: 'noul', probability: 0.1 },
            'branch-which': {
              type: 'choice',
              selected: 'none-of-these',
              distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 },
            },
          },
        })
      }
      const answers: Record<string, unknown> = {}
      for (const question of body.questions ?? []) {
        answers[question.id] =
          question.type === 'noul'
            ? { type: 'noul', probability: 0.95 }
            : { type: 'score', expected: 2, distribution: { '0': 0, '1': 0, '2': 1 } }
      }
      return jsonResponse(200, { answers })
    }
    if (url.includes('/api/muse/flexible')) {
      log.flexible += 1
      return jsonResponse(200, { outcome: 'no-draft', draft: null, model: 'muse-spark-1.3' })
    }
    return jsonResponse(404, { error: 'unstubbed' })
  }
  vi.stubGlobal('fetch', vi.fn(handler))
}

let container: HTMLDivElement
let root: Root
let log: FetchLog

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

async function waitFor(predicate: () => boolean, budgetMs = 20000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      ok = predicate()
    })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string {
  return container.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  log = { research: 0, researchStatuses: [], flexible: 0 }
  localStorage.clear()
  sessionStorage.clear()
  resetBudget()
  _resetPacing()
  resetPlaceIndexCache()
  ;(globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL] = {
    CENSUS_APP_KEY: 'fake-shared-key-for-tests',
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  resetPlaceIndexCache()
  delete (globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL]
})

describe('screen-path compose throw — the Arkansas battery', () => {
  it('research down: the AR rent screen card composes, schools recorded as lookup-failed, no bare note', async () => {
    installFetch(log, { researchMode: 'down' })
    render(<App />)
    await ask(OWNER_QUESTION)
    expect(await waitFor(() => pageText().includes('Pine Bluff'))).toBe(true)
    const text = pageText()
    // The research lookup really ran and really failed in this run.
    expect(log.research).toBeGreaterThanOrEqual(1)
    expect(log.researchStatuses).not.toContain(200)
    // The screen's card: a screened AR place with its Census rent.
    expect(text).toContain('$750')
    // The failed criterion degrades ONTO the card as a recorded
    // failure, in plain words — not as a schools claim.
    expect(text).toContain('School quality')
    expect(text).toContain(LOOKUP_FAILED_LINE)
    // The bare compose-failed note is not the terminal, and the
    // flexible lane is not the rescue here — the strict card is.
    expect(text).not.toContain(COMPOSE_FAILED_NOTE)
    expect(log.flexible).toBe(0)
  }, 90_000)

  it('research up: the same question composes with schools served by the cited research', async () => {
    installFetch(log, { researchMode: 'named' })
    render(<App />)
    await ask(OWNER_QUESTION)
    expect(await waitFor(() => pageText().includes('Pine Bluff'))).toBe(true)
    const text = pageText()
    expect(log.research).toBeGreaterThanOrEqual(1)
    expect(log.researchStatuses).toContain(200)
    expect(text).toContain('$750')
    // The degrade is failure-only: a returned lookup is accounted
    // from its claims, never stamped as failed.
    expect(text).not.toContain(LOOKUP_FAILED_LINE)
    expect(text).not.toContain(COMPOSE_FAILED_NOTE)
    expect(log.flexible).toBe(0)
  }, 90_000)
})
