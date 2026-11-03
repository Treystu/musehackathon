// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import type { ComposedAnswer } from '../../src/core/ai/answer'
import {
  createStubProvider,
  type IntentResult,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { SCREEN_VARS } from '../../src/core/plugins/acs'
import { resetPlaceIndexCache } from '../../src/core/zcta-place-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { StagedStatus } from '../../src/ui/ai/StagedStatus'
import {
  ASK_SESSION_STORAGE_KEY,
  AskSessionStore,
  deserializeSession,
  initialAnswerState,
  initialPanelState,
  serializeSession,
} from '../../src/ui/ai/session-store'

/**
 * INDICATOR LIFECYCLE AUDIT (owner live observation, 2026-11-02:
 * "the visual indicator is there regardless of if it's necessary,
 * or complete"). Evidence mounts only — no production code changes.
 *
 * The questions, in order:
 *  A. What does StagedStatus itself render for each store state
 *     (no run / run <1s / run >1s / stage cleared but still mounted)?
 *  B. How does the AskPanel mount (gated on panel.busy) behave at
 *     idle, mid-parse, and at each parse terminal (hand-off, error,
 *     clarification), and across a tab-switch round trip?
 *  C. How does the real App's answer-area mount (gated only on
 *     answerRequest in a ternary behind answer / answerNote) behave
 *     at idle, after a terminal note, after a card — and after a
 *     sessionStorage restore of a request that was in flight at
 *     reload, under (a) stalled loads and (b) healthy loads?
 *
 * CURE PASS (2026-11-02, same day): the audit confirmed the
 * observation three ways; the mounts below now pin the CURED
 * behavior. Assertions changed by a cure, with the cure named:
 *  - A1/A2/A4, B2/B3/B6: the dots render only while a run's stage
 *    is active AND past the 1-second clock (necessity/completion
 *    gating in StagedStatus) — sub-second and stage-less mounts
 *    now show the ack alone.
 *  - C4a/C4b: the persistence projection drops an unlanded
 *    request, so a restored in-flight request renders no
 *    indicator and no phantom pending state. The seed writes a
 *    RAW legacy payload (a pre-cure persisted session), because
 *    serializeSession itself now projects the request out.
 * Added with the cures:
 *  - C5: a fresh request whose sweep load stalls forever lands
 *    the load-failed note at the bounded wait and clears the
 *    indicator (fake timers drive the 45 s bound).
 *  - D1: the projection pins at the store level (serialize +
 *    deserialize; landed requests survive whole).
 *  - D2: single frame ownership — the panel's frame stands down
 *    once the answer layer adopts the run.
 *  - D3: the general lane's compose renders under the working
 *    frame (App level, gated general route).
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
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

const dots = () => container.querySelectorAll('.thinking-dot').length
const stagedLine = () => container.querySelector('[data-testid="staged-status-line"]')
const liveText = () =>
  container.querySelector('[data-testid="staged-status-live"]')?.textContent
const pageText = () => container.textContent ?? ''

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

const QUESTION = 'where is rent under $1,500'

/* ---------------- A. StagedStatus itself ---------------- */

describe('A. StagedStatus rendering per store state', () => {
  it('A1 no run at all (stage null): ack alone — no dots, no staged line, live region empty (cure: necessity gating)', () => {
    const store = new AskSessionStore(null, () => 100_000)
    render(
      <p>
        <StagedStatus session={store} ack="Let me look into that." />
      </p>,
    )
    expect(dots()).toBe(0)
    expect(pageText()).toContain('Let me look into that.')
    expect(stagedLine()).toBeNull()
    expect(liveText()).toBe('')
    expect(pageText()).not.toContain('Working on it')
  })

  it('A2 run under one second: ack alone; dots and staged line withheld; live region already holds the stage label (cure: necessity gating)', async () => {
    let now = 100_000
    const store = new AskSessionStore(null, () => now)
    store.beginStageRun('understanding')
    render(
      <p>
        <StagedStatus session={store} ack="On it — checking that for you." />
      </p>,
    )
    now += 400
    await flush(260)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
    expect(liveText()).toBe('Understanding your question')
  })

  it('A3 run past one second: the staged line joins ack + dots', async () => {
    let now = 100_000
    const store = new AskSessionStore(null, () => now)
    store.beginStageRun('understanding')
    render(
      <p>
        <StagedStatus session={store} ack="On it — checking that for you." />
      </p>,
    )
    now += 1_500
    await flush(260)
    expect(dots()).toBe(3)
    expect(stagedLine()?.textContent).toBe('Understanding your question')
  })

  it('A4 stage cleared but component still mounted: ack alone remains — the dots are stage-gated, not parent-gated (cure: completion gating)', async () => {
    let now = 100_000
    const store = new AskSessionStore(null, () => now)
    const token = store.beginStageRun('understanding')
    render(
      <p>
        <StagedStatus session={store} ack="On it — checking that for you." />
      </p>,
    )
    act(() => store.clearStage(token))
    now += 5_000
    await flush(260)
    expect(store.getSnapshot().stage).toBeNull()
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
    expect(liveText()).toBe('')
  })
})

/* ---------------- B. AskPanel mount (busy gate) ---------------- */

function Harness({
  store,
  provider,
  onAnswerRequest,
}: {
  store: AskSessionStore
  provider: ReturnType<typeof createStubProvider>
  onAnswerRequest: (intent: ValidatedIntent, queryText: string) => void
}) {
  const [tab, setTab] = useState<'ask' | 'map'>('ask')
  return (
    <div>
      <button type="button" data-testid="tab-ask" onClick={() => setTab('ask')}>
        Ask tab
      </button>
      <button type="button" data-testid="tab-map" onClick={() => setTab('map')}>
        Map tab
      </button>
      {tab === 'ask' ? (
        <AskPanel
          session={store}
          provider={provider}
          onAnswerRequest={onAnswerRequest}
          parseRetryDelaysMs={[]}
        />
      ) : (
        <p>Map tab surface</p>
      )}
    </div>
  )
}

function click(testId: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
  act(() => {
    el.click()
  })
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

describe('B. AskPanel busy-gated mount', () => {
  it('B1 idle: no indicator anywhere in the panel', () => {
    const store = new AskSessionStore(null)
    const provider = createStubProvider({ intent: async () => ({ intent: sweepIntent }) })
    render(<Harness store={store} provider={provider} onAnswerRequest={() => {}} />)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
  })

  it('B2 mid-parse (under one second): ack present, dots withheld until the run passes one second, staged line absent (cure: necessity gating)', async () => {
    const store = new AskSessionStore(null)
    const gate = deferred<IntentResult>()
    const provider = createStubProvider({ intent: () => gate.promise })
    render(<Harness store={store} provider={provider} onAnswerRequest={() => {}} />)
    await ask(QUESTION)
    await flush(20)
    expect(store.getSnapshot().panel.busy).toBe(true)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
  })

  it('B3 parse settles into a hand-off: panel indicator ends at parse settle, before any downstream answer exists', async () => {
    const store = new AskSessionStore(null)
    const gate = deferred<IntentResult>()
    const provider = createStubProvider({ intent: () => gate.promise })
    let handedOff: string | null = null
    render(
      <Harness
        store={store}
        provider={provider}
        onAnswerRequest={(_intent, queryText) => {
          handedOff = queryText
        }}
      />,
    )
    await ask(QUESTION)
    await flush(20)
    expect(dots()).toBe(0)
    gate.resolve({ intent: sweepIntent })
    await flush(60)
    expect(handedOff).toBe(QUESTION)
    expect(store.getSnapshot().panel.busy).toBe(false)
    expect(dots()).toBe(0)
  })

  it('B4 parse error terminal: note renders, indicator gone', async () => {
    const store = new AskSessionStore(null)
    const provider = createStubProvider({
      intent: async () => {
        throw new Error('boom')
      },
    })
    render(<Harness store={store} provider={provider} onAnswerRequest={() => {}} />)
    await ask(QUESTION)
    await flush(60)
    expect(pageText()).toContain('Ask is unavailable right now')
    expect(store.getSnapshot().panel.busy).toBe(false)
    expect(dots()).toBe(0)
  })

  it('B5 clarification terminal: clarification renders, indicator gone', async () => {
    const store = new AskSessionStore(null)
    const unclear: ValidatedIntent = {
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    const provider = createStubProvider({ intent: async () => ({ intent: unclear }) })
    render(<Harness store={store} provider={provider} onAnswerRequest={() => {}} />)
    await ask('compare two places')
    await flush(60)
    expect(pageText()).toContain('More detail is needed before anything runs')
    expect(dots()).toBe(0)
  })

  it('B6 tab-switch round trip: mid-run the panel unmounts (no dots in DOM) and remounts with the run; post-run it stays clean', async () => {
    const store = new AskSessionStore(null)
    const gate = deferred<IntentResult>()
    const provider = createStubProvider({ intent: () => gate.promise })
    render(<Harness store={store} provider={provider} onAnswerRequest={() => {}} />)
    await ask(QUESTION)
    await flush(20)
    // Sub-second: the frame is the ack alone (cure: necessity gating).
    expect(dots()).toBe(0)
    click('tab-map')
    expect(dots()).toBe(0)
    expect(store.getSnapshot().stage?.stage).toBe('understanding')
    click('tab-ask')
    // The run is still in flight past the 1-second clock on return:
    // the dots join the remounted frame.
    await flush(1300)
    expect(dots()).toBe(3)
    gate.resolve({ intent: sweepIntent })
    await flush(60)
    expect(dots()).toBe(0)
    click('tab-map')
    click('tab-ask')
    await flush(20)
    expect(dots()).toBe(0)
  })
})

/* ---------------- C. Real App answer-area mount ---------------- */

const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')
const TEST_ZCTAS = [
  '02101', '10001', '30301', '40771', '55401', '60601',
  '78701', '90210', '96720', '96749', '96778', '96821',
]
const RENT_BY_ZCTA: Record<string, number> = { '96720': 1450 }
const EXTERNAL_ONLY_INTENT = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}
const LOAD_FAILED_NOTE =
  'The country-wide data could not be loaded, so this question’s answer could not be composed.'
const OWNER_QUESTION_SCHOOLS =
  'Which area has the best schools and the fewest fast food restaurants?'

interface FetchLog {
  tigerweb: number
  census: number
  intent: number
  research: number
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(shape: { enumeration: 'fail' | 'ok' }, log: FetchLog) {
  const handler = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json')) {
      return new Response(PLACES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
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
    return jsonResponse(404, { error: 'unstubbed' })
  }
  vi.stubGlobal('fetch', vi.fn(handler))
}

function seedRestoredInFlightRequest() {
  // A session persisted by the PRE-CURE build, written raw:
  // serializeSession now projects an unlanded request out, so
  // seeding through it would erase the very state under test. The
  // shape below is exactly what the old build wrote for a request
  // that was in flight at reload (request present, answer and
  // note both null).
  const legacy = {
    v: 1,
    panel: { ...initialPanelState(), busy: false, ack: '', caughtError: null },
    answer: {
      request: { id: 7, intent: sweepIntent, queryText: QUESTION },
      answer: null,
      note: null,
      generalAnswer: null,
      generalNote: null,
      modal: { live: null, closedBranches: [], refinedBranches: [] },
    },
  }
  sessionStorage.setItem(ASK_SESSION_STORAGE_KEY, JSON.stringify(legacy))
}



describe('C. Real App: answer-area mount lifecycle', () => {
  it('C1 idle (no question asked): no dots anywhere', async () => {
    const log: FetchLog = { tigerweb: 0, census: 0, intent: 0, research: 0 }
    installFetch({ enumeration: 'ok' }, log)
    render(<App />)
    await flush(120)
    expect(dots()).toBe(0)
  })

  it('C2 after a terminal note (load failure): no dots, no staged line', async () => {
    const log: FetchLog = { tigerweb: 0, census: 0, intent: 0, research: 0 }
    installFetch({ enumeration: 'fail' }, log)
    render(<App />)
    expect(await waitFor(() => log.tigerweb >= 2)).toBe(true)
    await ask(OWNER_QUESTION_SCHOOLS)
    expect(await waitFor(() => pageText().includes(LOAD_FAILED_NOTE), 15000)).toBe(true)
    await flush(120)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
  }, 90_000)

  it('C3 after an answer card: no dots, no staged line', async () => {
    const log: FetchLog = { tigerweb: 0, census: 0, intent: 0, research: 0 }
    installFetch({ enumeration: 'ok' }, log)
    render(<App />)
    await ask(OWNER_QUESTION_SCHOOLS)
    expect(await waitFor(() => pageText().includes('School quality'), 20000)).toBe(true)
    await flush(120)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
  }, 90_000)

  it('C4a restored in-flight request (legacy payload) + stalled loads: no indicator, no phantom pending state (cure: persistence projection)', async () => {
    seedRestoredInFlightRequest()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    render(<App />)
    await flush(400)
    // The restore projection dropped the unlanded request: the
    // answer area has no mount key, so nothing renders — at any
    // point, however long the loads stall.
    expect(dots()).toBe(0)
    await flush(1600)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
    expect(pageText()).not.toContain('Let me look into that.')
    expect(pageText()).not.toContain(LOAD_FAILED_NOTE)
  }, 30_000)

  it('C4b restored in-flight request (legacy payload) + healthy loads: the projection drops the request; no indicator ever renders (cure: persistence projection)', async () => {
    seedRestoredInFlightRequest()
    const log: FetchLog = { tigerweb: 0, census: 0, intent: 0, research: 0 }
    installFetch({ enumeration: 'ok' }, log)
    render(<App />)
    // The sweep loads healthily; nothing re-drives the dropped
    // request and nothing renders for it.
    expect(await waitFor(() => log.census >= 1, 15000)).toBe(true)
    await flush(1500)
    expect(dots()).toBe(0)
    expect(stagedLine()).toBeNull()
    expect(pageText()).not.toContain('Let me look into that.')
    // The restore-side projection, read directly: the stored
    // legacy payload deserializes with no request.
    const restored = deserializeSession(sessionStorage.getItem(ASK_SESSION_STORAGE_KEY))
    expect(restored?.answer.request ?? null).toBeNull()
    expect(restored?.answer.answer ?? null).toBeNull()
    expect(restored?.answer.note ?? null).toBeNull()
  }, 90_000)

  it('C5 fresh request + sweep load stalls forever: the bounded wait lands the load-failed note and clears the indicator (cure: bounded wait)', async () => {
    vi.useFakeTimers()
    try {
      const log: FetchLog = { tigerweb: 0, census: 0, intent: 0, research: 0 }
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
          // The stalled load: this fetch never settles, so the
          // sweep stays 'loading' and the coverage wait is the only
          // thing standing between the request and a compose.
          return new Promise<Response>(() => {})
        }
        if (url.includes('/api/muse/intent')) {
          log.intent += 1
          return jsonResponse(200, { intent: EXTERNAL_ONLY_INTENT })
        }
        if (url.includes('/api/muse/research')) {
          log.research += 1
          return jsonResponse(200, {
            prose:
              'Hilo, HI elementary schools are rated above the state average in the cited directory.',
            sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
          })
        }
        return jsonResponse(404, { error: 'unstubbed' })
      }
      vi.stubGlobal('fetch', vi.fn(handler))
      render(<App />)
      await ask(OWNER_QUESTION_SCHOOLS)
      // Let the parse settle, the request be adopted, and the run
      // pass the 1-second clock inside the coverage wait: the
      // working frame is up (dots + staged line) while it waits.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(log.intent).toBeGreaterThanOrEqual(1)
      expect(dots()).toBe(3)
      expect(pageText()).not.toContain(LOAD_FAILED_NOTE)
      // Past the 45 s bound with the load still stalled: the wait
      // lands the load-failed note and the indicator clears.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50_000)
      })
      expect(pageText()).toContain(LOAD_FAILED_NOTE)
      expect(dots()).toBe(0)
      expect(stagedLine()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})

/* ---------------- D. Cure pins ---------------- */

describe('D1. Persistence projection (store level)', () => {
  const request = { id: 3, intent: sweepIntent, queryText: QUESTION }

  it('serialize drops a request with neither an answer nor a note landed', () => {
    const raw = serializeSession({
      panel: initialPanelState(),
      answer: { ...initialAnswerState(), request },
      stage: null,
    })
    const parsed = JSON.parse(raw) as { answer: { request: unknown } }
    expect(parsed.answer.request).toBeNull()
  })

  it('deserialize drops an unlanded request from a raw legacy payload', () => {
    const legacy = JSON.stringify({
      v: 1,
      panel: initialPanelState(),
      answer: {
        request,
        answer: null,
        note: null,
        generalAnswer: null,
        generalNote: null,
        modal: { live: null, closedBranches: [], refinedBranches: [] },
      },
    })
    const restored = deserializeSession(legacy)
    expect(restored?.answer.request ?? null).toBeNull()
  })

  it('a landed request survives whole: with a terminal note', () => {
    const raw = serializeSession({
      panel: initialPanelState(),
      answer: { ...initialAnswerState(), request, note: { id: 3, text: 'a terminal note' } },
      stage: null,
    })
    const restored = deserializeSession(raw)
    expect(restored?.answer.request?.id).toBe(3)
    expect(restored?.answer.note?.text).toBe('a terminal note')
  })

  it('a landed request survives whole: with a composed answer', () => {
    const answer = { status: 'verified' } as unknown as ComposedAnswer
    const raw = serializeSession({
      panel: initialPanelState(),
      answer: { ...initialAnswerState(), request, answer },
      stage: null,
    })
    const restored = deserializeSession(raw)
    expect(restored?.answer.request?.id).toBe(3)
    expect(restored?.answer.answer).toEqual({ status: 'verified' })
  })
})

describe('D2. Single frame ownership (AskPanel mount)', () => {
  function renderPanel(store: AskSessionStore) {
    const provider = createStubProvider({ intent: async () => ({ intent: sweepIntent }) })
    render(
      <AskPanel
        session={store}
        provider={provider}
        onAnswerRequest={() => {}}
        parseRetryDelaysMs={[]}
      />,
    )
  }

  function busyRunStore(): AskSessionStore {
    const store = new AskSessionStore(null)
    store.counters.lastQueryText = QUESTION
    store.setPanel({ busy: true, ack: 'On it — checking that for you.' })
    store.beginStageRun('understanding')
    return store
  }

  it('a busy run the answer layer has adopted: the panel frame stands down entirely', async () => {
    const store = busyRunStore()
    store.counters.requestAtRunStart = null
    store.setAnswerState({ request: { id: 11, intent: sweepIntent, queryText: QUESTION } })
    renderPanel(store)
    await flush(1300)
    expect(dots()).toBe(0)
    expect(container.querySelectorAll('[data-testid="staged-status-live"]')).toHaveLength(0)
  })

  it('a busy run not yet adopted: the panel frame renders — ack at once, dots past one second', async () => {
    const store = busyRunStore()
    store.counters.requestAtRunStart = null
    renderPanel(store)
    await flush(1300)
    expect(dots()).toBe(3)
    expect(container.querySelectorAll('[data-testid="staged-status-live"]')).toHaveLength(1)
  })

  it('a re-asked identical question: the request current at run start does not suppress the parse frame', async () => {
    const store = new AskSessionStore(null)
    const prior = { id: 4, intent: sweepIntent, queryText: QUESTION }
    store.setAnswerState({ request: prior })
    store.counters.requestAtRunStart = prior
    store.counters.lastQueryText = QUESTION
    store.setPanel({ busy: true, ack: 'On it — checking that for you.' })
    store.beginStageRun('understanding')
    renderPanel(store)
    await flush(1300)
    expect(dots()).toBe(3)
  })
})

describe('D3. General lane frame (real App)', () => {
  it('a general compose renders under the working frame — one owner — and clears when the answer lands', async () => {
    const generalGate = deferred<{ prose: string }>()
    const handler = async (input: RequestInfo | URL): Promise<Response> => {
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
        return jsonResponse(200, {
          intent: { ...EXTERNAL_ONLY_INTENT, domain: 'off_domain' },
        })
      }
      if (url.includes('/api/muse/general')) {
        const body = await generalGate.promise
        return jsonResponse(200, body)
      }
      if (url.includes('/api/muse/jev')) {
        // Jev unavailable in this harness: the general runner ships
        // the answer with no Jev claim, by its own contract.
        return jsonResponse(503, { error: 'jev_unavailable' })
      }
      if (url.includes('/api/muse/research')) {
        // Never settles: the standalone research settle must not
        // interfere with the frame assertions mid-run.
        return new Promise<Response>(() => {})
      }
      return jsonResponse(404, { error: 'unstubbed' })
    }
    vi.stubGlobal('fetch', vi.fn(handler))
    render(<App />)
    await ask('How many marbles would it take to fill the moon?')
    // The parse settles fast; the general compose is still gated.
    // Past the 1-second clock, its working frame is the page's one
    // staged frame.
    await flush(1500)
    expect(pageText()).toContain('Let me think that through.')
    expect(dots()).toBe(3)
    expect(container.querySelectorAll('[data-testid="staged-status-live"]')).toHaveLength(1)
    generalGate.resolve({
      prose:
        'A marble is about a centimetre across, and the Moon is vastly wider, ' +
        'so it would take an enormous number of marbles — far more than have ever been made.',
    })
    expect(
      await waitFor(() => pageText().includes("the model's own answer"), 15000),
    ).toBe(true)
    await flush(120)
    expect(dots()).toBe(0)
  }, 90_000)
})
