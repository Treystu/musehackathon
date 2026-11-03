// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import { grantMicConsent, type MicStorage } from '../../src/core/ai/mic'
import {
  createStubProvider,
  type IntentResult,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { resetPlaceIndexCache } from '../../src/core/zcta-place-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { SCREEN_VARS } from '../../src/core/plugins/acs'
import { AskPanel, EXAMPLE_PROMPTS } from '../../src/ui/ai/AskPanel'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import type {
  MicRecognitionHandlers,
  MicRecognizer,
} from '../../src/ui/ai/MicInput'

/**
 * ASK-SURFACE RESET + RUN LOCKOUT pins (owner live findings,
 * 2026-11-02 15:48 + 15:57 HST: "past runs are interspersed (mixed
 * up) with new runs... ensure that each new 'ask' clears previous
 * data, and runs fresh to answer cleanly — don't show ANY data,
 * other than the answer — and when the ask is running, then remove
 * the ask button"; and "my refreshing (hard refresh even) is
 * keeping the query in the tool... ensure that caching isn't too
 * sticky").
 *
 * Pin 1 (panel level): while a run is in flight the Ask button is
 * ABSENT from the DOM (removed, not disabled), and every other
 * run-start vector — a second form submit, an example chip, and a
 * voice final transcript landing mid-parse (the vector the audit
 * proved re-entrant) — starts no second run: the provider's intent
 * is called exactly once and the run's stage token never changes.
 * The button returns at the terminal.
 *
 * Pin 2 (real App, the answer-live-path harness): question 1 lands
 * its card and its execution's supporting blocks; the standing
 * stat band is present before the first ask and gone after it.
 * Question 2 is asked with its parse held: during the run, none of
 * question 1's data is anywhere on the Ask surface — not the card,
 * not the stat band, not the selected-places briefing — and the
 * Ask button is absent. After question 2's card lands, question
 * 1's blocks are still absent: only answer 2 renders.
 *
 * Pin 3 (refresh starts clean): sessionStorage seeded with a
 * landed legacy session (the strongest resurrection case: a
 * finished thread), plus the legacy inquiry and decisions keys —
 * a fresh App mount reads none of it: the Ask box is empty and no
 * restored question or answer stands on the surface. The
 * tab-switch half of the contract (in-page-life persistence) is
 * pinned in session-persistence-ui.test.tsx; the store-level half
 * in session-store.test.ts and indicator-lifecycle.test.tsx (D1).
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
  // The selection follows into the URL (?z=) as the reader works —
  // the deliberate shared-link channel, outside cure D's scope —
  // so a case's mount would otherwise inherit the previous case's
  // selection from the shared jsdom location (the answer-live-path
  // battery's beforeEach guards the same hazard).
  window.history.replaceState(null, '', window.location.pathname)
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function maybeButton(text: string): HTMLButtonElement | null {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
  return (found as HTMLButtonElement | undefined) ?? null
}

/**
 * The Ask form's submit button, exactly. (In the real App the
 * mode tab is also labeled 'Ask', so a text search is ambiguous
 * there; the panel pin above has no tabs and uses the text form.)
 */
function askSubmitButton(): HTMLButtonElement | null {
  const input = container.querySelector('#ask-input') as HTMLInputElement | null
  const form = input?.closest('form')
  return (form?.querySelector('button[type="submit"]') as HTMLButtonElement | null) ?? null
}

async function typeAndSubmit(text: string) {
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

/* ---------------- Pin 1: panel lockout ---------------- */

function fakeStorage(): MicStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

/** The mic-ui pattern: capture the session handlers, drive the utterance. */
function fakeRecognizer() {
  let handlers: MicRecognitionHandlers | null = null
  const recognizer: MicRecognizer = {
    async start(h) {
      handlers = h
    },
    abort() {},
  }
  const emit = {
    async final(result: { transcript: string; confidence: number }) {
      await act(async () => handlers?.onFinal(result))
    },
  }
  return { recognizer, emit }
}

const panelSweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
  clarificationNeeded: false,
}

describe('run lockout (panel level)', () => {
  it('the Ask button is removed while a run is in flight, every other vector starts no second run, and the button returns at the terminal', async () => {
    const store = new AskSessionStore()
    const gate = deferred<IntentResult>()
    let intentCalls = 0
    const provider = createStubProvider({
      intent: () => {
        intentCalls += 1
        return gate.promise
      },
    })
    const storage = fakeStorage()
    grantMicConsent(storage)
    const fake = fakeRecognizer()
    render(
      <AskPanel
        session={store}
        provider={provider}
        micRecognizer={fake.recognizer}
        micStorage={storage}
        parseRetryDelaysMs={[]}
      />,
    )
    await flush()
    // Idle: the button stands.
    expect(maybeButton('Ask')).not.toBeNull()

    // Start a voice session while idle, so a final transcript can
    // land mid-run — the audit's re-entrant vector.
    const voiceIcon = container.querySelector(
      'button[aria-label="Speak a question"]',
    ) as HTMLButtonElement
    await act(async () => {
      voiceIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // Start the run with a typed question; the parse is held.
    await typeAndSubmit('where is rent under $1,500')
    await flush()
    expect(intentCalls).toBe(1)
    expect(store.getSnapshot().panel.busy).toBe(true)
    const stageToken = store.getSnapshot().stage?.runToken
    expect(stageToken).not.toBeNull()

    // The button is REMOVED — not present-but-disabled.
    expect(maybeButton('Ask')).toBeNull()

    // Vector: a second form submit mid-run.
    const form = container.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    // Vector: an example chip mid-run (dispatched even though the
    // chip renders disabled — the state layer is what is pinned).
    const chip = maybeButton(EXAMPLE_PROMPTS[0]!)
    expect(chip).not.toBeNull()
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Vector: a voice final transcript landing mid-parse.
    await fake.emit.final({ transcript: 'where is rent cheapest in Hawaii', confidence: 0.99 })
    await flush()

    // One run, still the same run: one intent call, the same stage
    // token, still busy on the first question.
    expect(intentCalls).toBe(1)
    expect(store.getSnapshot().stage?.runToken).toBe(stageToken)
    expect(store.getSnapshot().panel.busy).toBe(true)
    expect(maybeButton('Ask')).toBeNull()

    // The terminal releases the lock exactly: the parse settles,
    // the run ends, and the button stands again.
    gate.resolve({ intent: panelSweepIntent })
    expect(await waitFor(() => store.getSnapshot().panel.busy === false)).toBe(true)
    await flush()
    expect(store.getSnapshot().stage).toBeNull()
    expect(maybeButton('Ask')).not.toBeNull()
  })
})

/* ---------------- Pin 2 + 3: the real App ---------------- */

const QUESTION_ONE = 'What is the median rent in Hilo?'
const QUESTION_TWO =
  'Which area has the best schools and the fewest fast food restaurants?'
const QUESTION_GENERAL = 'How many marbles would it take to fill the moon?'

const SWEEP_INTENT = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

/**
 * Question 1's parse: a lookup, whose execution opens the place's
 * drilldown — the state the briefing and comparison blocks render
 * from. (A sweep execution selects without opening drilldowns, so
 * it cannot prove the blocks stood before question 2 retired
 * them.)
 */
const LOOKUP_INTENT = {
  mode: 'lookup',
  geographies: ['Hilo, HI'],
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
  '78701', '90210', '96720', '96749', '96778', '96821',
]
const RENT_BY_ZCTA: Record<string, number> = { '96720': 1450 }

const PLACES_JSON = readFileSync(
  join(process.cwd(), 'public/map/zcta-places.json'),
  'utf8',
)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The answer-live-path network, with the intent route split by
 * question: question 1 parses to the sweep intent at once;
 * question 2's parse is held on the gate (the mid-run window),
 * then resolves to the research-first shape, whose research names
 * Austin, TX only.
 */
function installFetch(intentGate: Promise<unknown>) {
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
      const body = typeof init?.body === 'string' ? init.body : ''
      if (body.includes('best schools')) {
        await intentGate
        return jsonResponse(200, { intent: EXTERNAL_ONLY_INTENT })
      }
      if (body.includes('marbles')) {
        return jsonResponse(200, {
          intent: { ...EXTERNAL_ONLY_INTENT, domain: 'off_domain' },
        })
      }
      return jsonResponse(200, { intent: LOOKUP_INTENT })
    }
    if (url.includes('/api/muse/general')) {
      return jsonResponse(200, {
        prose:
          'A marble is about a centimetre across, and the Moon is vastly wider, ' +
          'so it would take an enormous number of marbles — far more than have ever been made.',
      })
    }
    if (url.includes('/api/muse/jev')) {
      // Jev unavailable in this harness: the general runner ships
      // the answer with no Jev claim, by its own contract (the
      // indicator battery's D3 pattern).
      return jsonResponse(503, { error: 'jev_unavailable' })
    }
    if (url.includes('/api/muse/research')) {
      return jsonResponse(200, {
        prose:
          'Austin, TX elementary schools are rated above the state average in the cited directory. ' +
          'Austin, TX has few fast-food outlets along its main street.',
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

describe('new-ask reset (real App)', () => {
  it("question 2's run and answer stand alone: question 1's card, the stat band, and the prior briefing are absent during the run and after its terminal", async () => {
    const gate = deferred<unknown>()
    installFetch(gate.promise)
    render(<App />)

    // The landing surface carries the standing stat band before
    // any ask — the gate is what retires it, so prove it stood.
    expect(
      await waitFor(() => pageText().includes('ZIP codes on the live screen')),
    ).toBe(true)

    // Question 1: card + execution blocks land. (The card's place
    // marker is 'Hilo, HI' throughout this file: the bare word
    // 'Hilo' also stands in an example chip on the landing surface.)
    await typeAndSubmit(QUESTION_ONE)
    expect(
      await waitFor(() => pageText().includes('Hilo, HI') && pageText().includes('$1,450/mo')),
    ).toBe(true)
    // The execution's supporting blocks derive from the drilldowns
    // the execution opens; they land on their own fetches, just
    // behind the card. The briefing block's rendered heading is
    // 'Briefing pack' (its 'Selected places' title is pack
    // metadata, not on-screen text).
    expect(await waitFor(() => pageText().includes('Briefing pack'))).toBe(true)
    // The stat band retired with the first ask.
    expect(pageText()).not.toContain('ZIP codes on the live screen')

    // Question 2, parse held: the mid-run surface carries none of
    // question 1's data, and no Ask button stands to be clicked.
    await typeAndSubmit(QUESTION_TWO)
    await flush(120)
    expect(askSubmitButton()).toBeNull()
    expect(pageText()).not.toContain('Hilo, HI')
    expect(pageText()).not.toContain('$1,450')
    expect(pageText()).not.toContain('Briefing pack')
    expect(pageText()).not.toContain('ZIP codes on the live screen')

    // Release the parse: question 2's card lands, naming its own
    // place — and question 1's blocks stay retired after the
    // terminal (question 2's research-first run executes nothing
    // into the selection the blocks render from).
    gate.resolve(null)
    expect(await waitFor(() => pageText().includes('School quality'))).toBe(true)
    expect(pageText()).toContain('Austin, TX')
    expect(pageText()).not.toContain('Hilo, HI')
    expect(pageText()).not.toContain('Briefing pack')
    expect(pageText()).not.toContain('ZIP codes on the live screen')
    expect(askSubmitButton()).not.toBeNull()
  }, 90_000)

  it('the stat band retires at the first ask even when the ask selects nothing (the generation gate, isolated)', async () => {
    // A general question executes nothing and selects nothing, so
    // every other condition the band renders under is unchanged
    // across the ask — the only thing that changed is the ask
    // generation. If the band is gone after the answer, the
    // generation gate is what removed it.
    const gate = deferred<unknown>()
    installFetch(gate.promise)
    render(<App />)
    expect(
      await waitFor(() => pageText().includes('ZIP codes on the live screen')),
    ).toBe(true)
    await typeAndSubmit(QUESTION_GENERAL)
    expect(
      await waitFor(() => pageText().includes("the model's own answer")),
    ).toBe(true)
    expect(pageText()).not.toContain('ZIP codes on the live screen')
  }, 90_000)
})

describe('refresh starts clean (real App)', () => {
  it('a fresh mount reads no persisted session: empty Ask box, no restored question or answer', async () => {
    // Seed exactly what the retired build wrote at the end of a
    // finished session: the question in the box, its understood
    // request, and its landed answer — plus the companion
    // session keys the ask conversation used.
    const legacy = {
      v: 1,
      panel: {
        text: 'where is rent under $1,500',
        ack: '',
        intent: SWEEP_INTENT,
        note: '',
        busy: false,
        caughtError: null,
        executionNote: '',
        coverageNote: '',
        research: { status: 'idle' },
      },
      answer: {
        request: { id: 7, intent: SWEEP_INTENT, queryText: 'where is rent under $1,500' },
        answer: { status: 'verified', places: [{ name: 'Hilo, HI' }] },
        note: null,
        generalAnswer: null,
        generalNote: null,
        modal: { live: null, closedBranches: ['transport'], refinedBranches: [] },
      },
    }
    sessionStorage.setItem('civicscope.ask-session.v1', JSON.stringify(legacy))
    sessionStorage.setItem('civicscope.inquiry.v1', JSON.stringify({ asked: true, wavedOff: true }))
    sessionStorage.setItem('civicscope.decisions', 'transport=no-car')

    const gate = deferred<unknown>()
    installFetch(gate.promise)
    render(<App />)
    await flush(200)

    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('')
    expect(pageText()).not.toContain('where is rent under $1,500')
    // The seeded answer's place, in its rendered name form (the
    // bare word 'Hilo' stands in an example chip by design).
    expect(pageText()).not.toContain('Hilo, HI')
  }, 30_000)
})
