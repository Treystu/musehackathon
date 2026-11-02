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
 * The research-first dead-end, reproduced against the REAL data path
 * (Round 11 hourly burndown, 2026-11-02; second owner repro the same
 * morning). The fixture pin for the owner's exact question
 * (research-first-handoff.test.tsx) passes because it stubs every
 * App-side seam: it captures onAnswerRequest and calls the pipeline
 * directly with rows already loaded. The live failure lives in the
 * seam that pin never exercises — App's answer effect waiting on
 * useHousingQuery's sweep coverage — so this file mounts the real
 * App, the real place index (the shipped public/map/zcta-places.json
 * served from disk), the real sweep machinery (listAllZctas ->
 * planChunks -> fetchChunk -> areaRowFromRaw), and the real live
 * provider's wire shapes. Only the network itself is stubbed, at the
 * fetch seam the production build uses.
 *
 * Live shape being reproduced (both owner instances, production
 * 806d9e6): the research-first handoff line renders, and then nothing
 * — no answer card, no note, no fallback. Server-side diagnostics
 * bracketed both windows (Round 11 round-end: requests 149, errors
 * {provider_down: 4, invented_numeral: 1}; read at 10:40 HST after
 * the second repro: requests 150, +1000 micro, errors unchanged) —
 * exactly one intent settle across both asks and NO research settle,
 * which places the terminal branch BEFORE the pipeline's research
 * stage: the sweep-coverage wait in App's answer effect. That wait
 * had no terminal state: while the load churned it rendered nothing,
 * and once the load errored after the effect's single scoped-load
 * attempt, the one-shot answerLoadIds guard stranded the request
 * permanently. The compose catch is the same silence class one stage
 * later. These tests pin every terminal state of the answer area:
 * card, or an honest note.
 */

const OWNER_QUESTION_SCHOOLS =
  'Which area has the best schools and the fewest fast food restaurants?'
const OWNER_QUESTION_TOP_FIVE =
  'find the top five places that have the best schools but also the least average cost of living'

const HANDOFF_LINE = 'answered from research first'
const LOAD_FAILED_NOTE =
  'The country-wide data could not be loaded, so this question’s answer could not be composed.'
const COMPOSE_FAILED_NOTE = 'The answer to this question could not be composed just now.'

/** The external-only parse shape both live asks produced (the handoff line proves it). */
const EXTERNAL_ONLY_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

/** ZCTAs the stubbed TIGERweb enumeration returns — the sweep's whole country here. */
const TEST_ZCTAS = [
  '02101', '10001', '30301', '40771', '55401', '60601',
  '78701', '90210', '96720', '96749', '96778', '96821',
]
const RENT_BY_ZCTA: Record<string, number> = { '96720': 1450 }

const PLACES_JSON = readFileSync(
  join(process.cwd(), 'public/map/zcta-places.json'),
  'utf8',
)

interface FetchLog {
  tigerweb: number
  census: number
  intent: number
  research: number
}

interface NetworkShape {
  /** 'fail' = the enumeration endpoint answers HTTP 400 (a non-retryable
   * failure keeps the test fast; the load-error branch it drives is the
   * same one a retryable 5xx reaches after its backoff, only slower). */
  enumeration: 'fail' | 'ok'
  research: 'fail' | 'schools' | 'top-five'
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(shape: NetworkShape, log: FetchLog) {
  const handler = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json')) {
      return new Response(PLACES_JSON, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('tigerweb.geo.census.gov')) {
      log.tigerweb += 1
      if (shape.enumeration === 'fail') {
        return jsonResponse(400, { error: { message: 'stubbed enumeration failure' } })
      }
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
      log.census += 1
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
      log.intent += 1
      return jsonResponse(200, { intent: EXTERNAL_ONLY_INTENT })
    }
    if (url.includes('/api/muse/research')) {
      log.research += 1
      if (shape.research === 'fail') {
        return jsonResponse(503, { error: 'provider_down' })
      }
      if (shape.research === 'schools') {
        return jsonResponse(200, {
          prose:
            'Hilo, HI elementary schools are rated above the state average in the cited directory. ' +
            'Hilo, HI has few fast-food outlets along its main street.',
          sources: [
            { title: 'State school directory', url: 'https://example.org/schools' },
            { title: 'Local dining guide', url: 'https://example.org/dining' },
          ],
        })
      }
      return jsonResponse(200, {
        prose:
          'Hilo, HI schools are rated above the state average in the cited directory. ' +
          'Corbin, KY schools are rated above the state average in the cited directory. ' +
          'Austin, TX schools are rated above the state average in the cited directory.',
        sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
      })
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

/** Poll inside act until the predicate holds or the budget runs out. */
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
  log = { tigerweb: 0, census: 0, intent: 0, research: 0 }
  localStorage.clear()
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

describe('answer layer on the real data path: terminal states', () => {
  it('load failure (the confirmed live branch): handoff, no research fired, honest note — never silence', async () => {
    installFetch({ enumeration: 'fail', research: 'schools' }, log)
    render(<App />)
    // Both mount-time enumeration consumers fail; the sweep is in its
    // error state before the question is asked.
    expect(await waitFor(() => log.tigerweb >= 2)).toBe(true)

    await ask(OWNER_QUESTION_SCHOOLS)
    expect(await waitFor(() => pageText().includes(HANDOFF_LINE))).toBe(true)
    // The answer effect spends its one scoped load attempt; it fails
    // the same way, and the request reaches its terminal state.
    expect(await waitFor(() => log.tigerweb >= 3)).toBe(true)
    expect(await waitFor(() => pageText().includes(LOAD_FAILED_NOTE), 8000)).toBe(true)
    // Live-shape fidelity: research never fired (server-side, both
    // owner windows settled no research call either).
    expect(log.research).toBe(0)
    expect(pageText()).not.toContain('Hilo, HI elementary schools')
  }, 90_000)

  it('compose failure (the swallowed catch): research fired and failed, honest note — never silence', async () => {
    installFetch({ enumeration: 'ok', research: 'fail' }, log)
    render(<App />)
    await ask(OWNER_QUESTION_SCHOOLS)
    expect(await waitFor(() => pageText().includes(HANDOFF_LINE))).toBe(true)
    // The load lands, compose starts, the research stage fails — the
    // divergence from the load-failure case, proven by the call count.
    expect(await waitFor(() => log.research >= 1)).toBe(true)
    expect(await waitFor(() => pageText().includes(COMPOSE_FAILED_NOTE), 8000)).toBe(true)
  }, 90_000)

  it('the owner’s schools + fast-food question composes its card end to end on the real seams', async () => {
    installFetch({ enumeration: 'ok', research: 'schools' }, log)
    render(<App />)
    await ask(OWNER_QUESTION_SCHOOLS)
    expect(await waitFor(() => pageText().includes('School quality'))).toBe(true)
    const text = pageText()
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('$1,450/mo')
    expect(text).toContain('partially measured')
    expect(log.research).toBeGreaterThanOrEqual(1)
  }, 90_000)

  it('the owner’s top-five question: fewer grounded places than asked renders the card with the shortfall stated', async () => {
    installFetch({ enumeration: 'ok', research: 'top-five' }, log)
    render(<App />)
    await ask(OWNER_QUESTION_TOP_FIVE)
    // Research names three matchable places; five were asked for. The
    // card names the three and states the shortfall — a grounded
    // partial answer, never the handoff line standing alone.
    expect(await waitFor(() => pageText().includes('School quality'))).toBe(true)
    const text = pageText()
    expect(text).toContain('Hilo, HI')
    expect(text).toContain('Corbin, KY')
    expect(text).toContain('Austin, TX')
    expect(text).toContain('You asked for 5 places')
    expect(text).toContain('named 3')
  }, 90_000)
})
