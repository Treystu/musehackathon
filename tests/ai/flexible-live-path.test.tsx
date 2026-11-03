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
 * The flexible completion on the REAL data path (2026-11-02): the
 * owner's exact sentence 1 — "Where can I find the best schools but
 * also the fewest fast food restaurants?" — with fixture research
 * naming places that match no Census data. Live, this question
 * terminated on the bare not-matched note in two consecutive
 * windows (14:44 + 14:54 HST captures); it is the fall-through's
 * named case. The harness is answer-live-path.test.tsx's: the real
 * App, the real place index from disk, the real sweep machinery,
 * the real live provider's wire shapes — only the network is
 * stubbed, now including the conversational stack's routes and the
 * flexible route, whose draft fixture names the research places
 * under the research evidence class.
 */

const SENTENCE_1 = 'Where can I find the best schools but also the fewest fast food restaurants?'
const NOT_MATCHED_NOTE = 'did not name a place that could be matched to Census data'

const EXTERNAL_ONLY_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const TEST_ZCTAS = [
  '02101', '10001', '30301', '40771', '55401', '60601',
  '78701', '90210', '96720', '96749', '96778', '96821',
]
const RENT_BY_ZCTA: Record<string, number> = { '96720': 1450 }

const PLACES_JSON = readFileSync(
  join(process.cwd(), 'public/map/zcta-places.json'),
  'utf8',
)

const FLEXIBLE_DRAFT = {
  prose:
    'Stone Mountain, GA and Kingwood, TX are the places the cited research named for the ' +
    'stated criteria. The research describes Stone Mountain schools as rated above the ' +
    'state average, and Kingwood as having few fast-food outlets along its main roads.',
  places: [
    { name: 'Stone Mountain, GA', basis: 'research', note: 'Named by the cited research for school quality.', figures: [] },
    { name: 'Kingwood, TX', basis: 'research', note: 'Named by the cited research for few fast-food outlets.', figures: [] },
  ],
  figures: [
    {
      label: 'Fast-food outlets named in the findings for Kingwood',
      value: 6,
      basis: 'research',
    },
  ],
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
  /**
   * Research wire behavior: 'named' returns the findings fixture on
   * every call; 'down' fails every call (provider_down); 'partial'
   * returns the fixture on the first call and fails every later
   * call — the multi-pass partial failure (pass 1 gathers material,
   * a later pass hits the flap).
   */
  researchMode?: 'named' | 'down' | 'partial'
  researchBody?: { prose: string; sources: { title: string; url: string }[] }
  draft?: unknown
}

const NAMED_RESEARCH_BODY = {
  prose:
    'Stone Mountain, GA schools are rated above the state average in the cited directory. ' +
    'Kingwood, TX has few fast-food outlets along its main roads.',
  sources: [
    { title: 'State school directory', url: 'https://example.org/schools' },
    { title: 'Local dining guide', url: 'https://example.org/dining' },
  ],
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
      return jsonResponse(200, { intent: EXTERNAL_ONLY_INTENT })
    }
    if (url.includes('/api/muse/research')) {
      log.research += 1
      const mode = options.researchMode ?? 'named'
      const fail =
        mode === 'down' || (mode === 'partial' && log.research > 1)
      log.researchStatuses.push(fail ? 500 : 200)
      if (fail) return jsonResponse(500, { error: 'provider_down' })
      return jsonResponse(200, options.researchBody ?? NAMED_RESEARCH_BODY)
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
      return jsonResponse(200, {
        outcome: 'draft',
        draft: options.draft ?? FLEXIBLE_DRAFT,
        model: 'muse-spark-1.3',
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

describe('flexible completion on the real data path', () => {
  it('sentence 1 with research naming unmatched places completes with labelled places, not the bare note', async () => {
    installFetch(log)
    render(<App />)
    await ask(SENTENCE_1)
    expect(await waitFor(() => pageText().includes('Stone Mountain, GA'))).toBe(true)
    const text = pageText()
    expect(log.research).toBeGreaterThanOrEqual(1)
    expect(log.flexible).toBeGreaterThanOrEqual(1)
    expect(text).toContain('Kingwood, TX')
    // The completion's framing: the match outcome is stated, and
    // every named place carries its evidence class in plain words.
    expect(text).toContain('none could be matched to Census data')
    expect(text).toContain('Named in research — not matched to Census data')
    // The bare not-matched note is not the terminal any more.
    expect(text).not.toContain(NOT_MATCHED_NOTE)
  }, 90_000)
})

/**
 * The trigger-gap battery (2026-11-02, owner live finding): the
 * owner's exact question — "what city/zip has the lowest cost of
 * living but also the best schools?" — terminated live on the
 * compose-failed note ("The answer to this question could not be
 * composed just now"). The diagnosis (drive-scratch RESULTS): the
 * note is the research-failure terminal, and the gap was the
 * multi-pass discard — one pass's gathered material thrown away
 * when a later pass failed. These three cases pin the cured
 * behavior on the real App path.
 */
const OWNER_QUESTION = 'what city/zip has the lowest cost of living but also the best schools?'
const COMPOSE_FAILED_NOTE = 'could not be composed just now'

const OWNER_RESEARCH_BODY = {
  prose:
    'Stone Mountain, GA schools are rated above the state average in the cited directory. ' +
    'Yellow Springs, OH is named among the lowest cost-of-living towns in the cited guide.',
  sources: [
    { title: 'State school directory', url: 'https://example.org/schools' },
    { title: 'Cost-of-living guide', url: 'https://example.org/cost-of-living' },
  ],
}

const OWNER_DRAFT = {
  prose:
    'Stone Mountain, GA and Yellow Springs, OH are the places the cited research named for ' +
    'the stated criteria. The research describes Stone Mountain schools as rated above the ' +
    'state average, and names Yellow Springs among the lowest cost-of-living towns.',
  places: [
    { name: 'Stone Mountain, GA', basis: 'research', note: 'Named by the cited research for school quality.', figures: [] },
    { name: 'Yellow Springs, OH', basis: 'research', note: 'Named by the cited research among the lowest cost-of-living towns.', figures: [] },
  ],
  figures: [],
}

describe('flexible trigger gap — the owner question battery', () => {
  it('the owner question completes flexibly when research names unmatched places', async () => {
    installFetch(log, { researchBody: OWNER_RESEARCH_BODY, draft: OWNER_DRAFT })
    render(<App />)
    await ask(OWNER_QUESTION)
    expect(await waitFor(() => pageText().includes('Yellow Springs, OH'))).toBe(true)
    const text = pageText()
    expect(log.research).toBeGreaterThanOrEqual(1)
    expect(log.flexible).toBeGreaterThanOrEqual(1)
    expect(text).toContain('Stone Mountain, GA')
    expect(text).toContain('Named in research — not matched to Census data')
    // Neither bare note is the terminal.
    expect(text).not.toContain(COMPOSE_FAILED_NOTE)
    expect(text).not.toContain(NOT_MATCHED_NOTE)
  }, 90_000)

  it('a later research pass failing mid-run no longer strands the question on the compose-failed note', async () => {
    installFetch(log, { researchMode: 'partial' })
    render(<App />)
    await ask(SENTENCE_1)
    expect(await waitFor(() => pageText().includes('Stone Mountain, GA'))).toBe(true)
    const text = pageText()
    // A pass really did fail in this run (the flap is in the wire
    // log), and the material pass 1 gathered still completed.
    expect(log.researchStatuses).toContain(500)
    expect(log.flexible).toBeGreaterThanOrEqual(1)
    expect(text).toContain('Named in research — not matched to Census data')
    expect(text).not.toContain(COMPOSE_FAILED_NOTE)
    expect(text).not.toContain(NOT_MATCHED_NOTE)
  }, 90_000)

  it('research fully down: the honest note stands and the flexible route is never called', async () => {
    installFetch(log, { researchMode: 'down' })
    render(<App />)
    await ask(OWNER_QUESTION)
    // Compose-degradation cure (2026-11-03): the total failure
    // composes the honest-note answer in-pipeline — the
    // lookup-failure summary — rather than throwing to the bare
    // compose-failed note this case pinned before the cure. The
    // note carries no research material (no marker, no named
    // places), so the flexible route stays uncalled, as asserted
    // below.
    expect(await waitFor(() => pageText().includes('did not return'))).toBe(true)
    expect(pageText()).not.toContain(COMPOSE_FAILED_NOTE)
    const text = pageText()
    expect(log.research).toBeGreaterThanOrEqual(1)
    expect(log.researchStatuses).not.toContain(200)
    // No named material exists to ground a completion on: the lane
    // must not manufacture one from model knowledge alone.
    expect(log.flexible).toBe(0)
    expect(text).not.toContain('Yellow Springs, OH')
  }, 90_000)
})
