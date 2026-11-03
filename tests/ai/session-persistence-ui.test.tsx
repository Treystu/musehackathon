// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { runAnswerPipeline, type ComposedAnswer } from '../../src/core/ai/answer'
import {
  createStubProvider,
  type IntentResult,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { sessionMapModel } from '../../src/core/map/session-map'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { StagedStatus } from '../../src/ui/ai/StagedStatus'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import { SessionMapView } from '../../src/ui/map/SessionMapView'

/**
 * Item 17 pins, surface level.
 *
 * The harness reproduces App's tab structure exactly where it
 * matters: AskPanel is mounted only on the Ask tab, so switching
 * tabs unmounts it — the pre-cure defect's mechanism. The session
 * store is created above the tabs and passed in, as App now does.
 * The pins: a tab switch mid-flight loses nothing (the parse
 * completes into the store, the answer request fires, the tracked
 * compose run lands its answer with the panel unmounted, and the
 * remounted panel shows the question and the understood request);
 * a switch after an answer preserves the thread; the staged status
 * obeys the 1-second rule and its aria-live text changes only on
 * stage transitions; the Map view is the session's results.
 */

const ROWS: AreaRow[] = [
  {
    zcta: '96720',
    name: 'Hilo, HI',
    metrics: { median_gross_rent: 1450, median_home_value: 300000 },
    moes: { median_gross_rent: 85, median_home_value: 20000 },
  },
  {
    zcta: '96749',
    name: 'Keaau, HI',
    metrics: { median_gross_rent: 1325, median_home_value: 450000 },
    moes: { median_gross_rent: 120, median_home_value: 30000 },
  },
  {
    zcta: '96778',
    name: 'Pahoa, HI',
    metrics: { median_gross_rent: 1750, median_home_value: 340000 },
    moes: { median_gross_rent: 150, median_home_value: 25000 },
  },
]

const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

const QUESTION = 'where is rent under $1,500'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** App's shape in miniature: tabs above, store above the tabs, panel only on Ask. */
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

/** The App-side answer handler, in miniature: request into the store, compose tracked by the store. */
function appLikeAnswerHandler(store: AskSessionStore) {
  let seq = 0
  return (intent: ValidatedIntent, queryText: string) => {
    const id = ++seq
    store.setAnswerState({ request: { id, intent, queryText }, answer: null, note: null })
    const run = (async () => {
      const composed = await runAnswerPipeline({ intent, rows: ROWS })
      store.setAnswerState({ answer: composed })
      return composed
    })()
    store.trackRun(`answer:${id}`, run)
    void run
  }
}

describe('tab switch and the Ask session (item 17a)', () => {
  it('mid-flight: the parse and the answer complete into the store while the panel is unmounted', async () => {
    const store = new AskSessionStore()
    const gate = deferred<IntentResult>()
    let intentCalls = 0
    const provider = createStubProvider({
      intent: () => {
        intentCalls += 1
        return gate.promise
      },
    })
    render(<Harness store={store} provider={provider} onAnswerRequest={appLikeAnswerHandler(store)} />)
    await ask(QUESTION)
    await flush()
    // The run is in flight: busy, stage at understanding.
    expect(store.getSnapshot().panel.busy).toBe(true)
    expect(store.getSnapshot().stage?.stage).toBe('understanding')
    expect(intentCalls).toBe(1)

    // Switch to the Map tab mid-flight: AskPanel unmounts.
    click('tab-map')
    expect(container.querySelector('#ask-input')).toBeNull()

    // The parse lands while nothing of the panel is mounted.
    gate.resolve({ intent: sweepIntent })
    await flush(60)

    // Nothing was cancelled or restarted, and everything landed in
    // the session: understood request, answer request, the answer.
    expect(intentCalls).toBe(1)
    const snapshot = store.getSnapshot()
    expect(snapshot.panel.intent?.mode).toBe('sweep_filter')
    expect(snapshot.panel.busy).toBe(false)
    expect(snapshot.answer.request?.queryText).toBe(QUESTION)
    expect(snapshot.answer.answer?.status).toBe('verified')
    expect(snapshot.answer.answer?.places.map((p) => p.name)).toEqual(['Hilo, HI', 'Keaau, HI'])
    expect(store.inFlightKeys()).toEqual([])

    // Back on the Ask tab, the thread is waiting: the question in
    // the box and the understood request on screen.
    click('tab-ask')
    await flush()
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe(QUESTION)
    expect(container.querySelector('[aria-label="Edit the understood request"]')).not.toBeNull()
  })

  it('after an answer: question, thread, and answer survive a switch away and back', async () => {
    const store = new AskSessionStore()
    const provider = createStubProvider({
      intent: async () => ({ intent: sweepIntent }),
    })
    render(<Harness store={store} provider={provider} onAnswerRequest={appLikeAnswerHandler(store)} />)
    await ask(QUESTION)
    await flush(60)
    expect(store.getSnapshot().answer.answer?.status).toBe('verified')

    click('tab-map')
    click('tab-ask')
    await flush()
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe(QUESTION)
    expect(container.querySelector('[aria-label="Edit the understood request"]')).not.toBeNull()
    const snapshot = store.getSnapshot()
    expect(snapshot.panel.intent?.mode).toBe('sweep_filter')
    expect(snapshot.answer.answer?.places).toHaveLength(2)
    expect(snapshot.answer.request?.queryText).toBe(QUESTION)
  })
})

describe('staged status (item 17b)', () => {
  it('under one second the ack suffices; past it the stage line appears; the live text changes only on transitions', async () => {
    let now = 50_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun('understanding')
    render(
      <p>
        <StagedStatus session={store} ack="On it — checking that for you." />
      </p>,
    )
    const line = () => container.querySelector('[data-testid="staged-status-line"]')
    const live = () => container.querySelector('[data-testid="staged-status-live"]')?.textContent
    // Fast window: no staged line; the live text already holds the
    // stage (so its later changes are transitions only).
    expect(line()).toBeNull()
    expect(live()).toBe('Understanding your question')

    now += 900
    await flush(260)
    expect(line()).toBeNull()
    expect(live()).toBe('Understanding your question')

    // A stage transition is announced; the visible line still waits
    // for the run's first second to pass.
    act(() => store.setStage(token, 'researching', 'School quality'))
    expect(live()).toBe('Researching School quality')
    expect(line()).toBeNull()

    now += 200
    await flush(260)
    expect(line()?.textContent).toBe('Researching School quality')
    expect(live()).toBe('Researching School quality')

    // Time passing inside one stage changes neither text.
    now += 5_000
    await flush(260)
    expect(line()?.textContent).toBe('Researching School quality')
    expect(live()).toBe('Researching School quality')

    act(() => store.setStage(token, 'composing'))
    expect(live()).toBe('Composing your answer')
    expect(line()?.textContent).toBe('Composing your answer')
  })

  it('a fast run never shows the staged line', async () => {
    let now = 90_000
    const store = new AskSessionStore(() => now)
    const token = store.beginStageRun('understanding')
    render(
      <p>
        <StagedStatus session={store} ack="Let me look into that." />
      </p>,
    )
    act(() => store.clearStage(token))
    now += 5_000
    await flush(260)
    expect(container.querySelector('[data-testid="staged-status-line"]')).toBeNull()
    expect(container.querySelector('[data-testid="staged-status-live"]')?.textContent).toBe('')
  })
})

describe('Map = session results (item 17c)', () => {
  async function answerFor(intent: ValidatedIntent): Promise<ComposedAnswer> {
    const answer = await runAnswerPipeline({ intent, rows: ROWS })
    expect(answer.status).toBe('verified')
    return answer
  }

  it('a fresh session shows the inviting empty state', () => {
    expect(sessionMapModel(null)).toEqual({ kind: 'empty' })
    render(<SessionMapView answer={null} questionText={null} />)
    expect(container.textContent).toContain('Ask a question and its map appears here')
  })

  it('after a geographic answer the Map view shows its places and driving metric; a new answer replaces them', async () => {
    const rentAnswer = await answerFor(sweepIntent)
    expect(sessionMapModel(rentAnswer)).toEqual({
      kind: 'results',
      placeCount: 2,
      drivingMetricKey: 'median_gross_rent',
      drivingMetricLabel: 'Median gross rent',
    })
    render(<SessionMapView answer={rentAnswer} questionText={QUESTION} />)
    let text = container.textContent ?? ''
    expect(text).toContain('Map of your results')
    expect(text).toContain(QUESTION)
    expect(text).toContain('2 places from your last answer')
    expect(text).toContain('colored by Median gross rent')
    // The shipped ResultMap machinery is what draws it.
    // REVISED PIN (item-16 cure C4, 2026-11-02): this asserted the
    // ResultMap's "Show the map for this answer" gate button as the
    // machinery's tell. C4 removed that button — the load starts on
    // mount — so the tell is now the machinery's own loading line,
    // and the gate button's absence is asserted with it.
    expect(text).toContain('Loading the map for this answer')
    expect(text).not.toContain('Show the map for this answer')

    const homeIntent: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_home_value'],
      filters: [{ metricKey: 'median_home_value', op: 'lt', value: 400000 }],
      clarificationNeeded: false,
    }
    const homeAnswer = await answerFor(homeIntent)
    expect(sessionMapModel(homeAnswer)).toEqual({
      kind: 'results',
      placeCount: 2,
      drivingMetricKey: 'median_home_value',
      drivingMetricLabel: 'Median home value',
    })
    render(<SessionMapView answer={homeAnswer} questionText="where are home values under $400,000" />)
    text = container.textContent ?? ''
    expect(text).toContain('colored by Median home value')
    expect(text).toContain('where are home values under $400,000')
    expect(text).not.toContain('Median gross rent')
  })

  it('the empty state demotes the national overview to a one-click link (item 18 S2)', () => {
    // The overview is passed in but not rendered: it appears only
    // after the "See the whole country" click, and the link gives
    // way to it — demoted, not standing tab content, not deleted.
    render(
      <SessionMapView
        answer={null}
        questionText={null}
        overview={<p>national hex overview</p>}
      />,
    )
    expect(container.textContent).toContain('Ask a question and its map appears here')
    expect(container.textContent).toContain('See the whole country')
    expect(container.textContent).not.toContain('national hex overview')
    const link = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'See the whole country',
    )
    if (!link) throw new Error('overview link not found')
    act(() => link.click())
    expect(container.textContent).toContain('national hex overview')
    expect(container.textContent).not.toContain('See the whole country')
  })

  it('an answer that verified no places keeps the empty state', async () => {
    const withheld = await runAnswerPipeline({
      intent: { ...sweepIntent, filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 100 }] },
      rows: ROWS,
    })
    expect(withheld.places).toHaveLength(0)
    expect(sessionMapModel(withheld as ComposedAnswer)).toEqual({ kind: 'empty' })
    render(<SessionMapView answer={withheld as ComposedAnswer} questionText="rent under $100" />)
    expect(container.textContent).toContain('Ask a question and its map appears here')
  })
})
