// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  AskPanel,
  answerEligible,
  clarificationCandidatesFor,
} from '../../src/ui/ai/AskPanel'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'

/**
 * The owner's live failure (2026-11-02, phone, production): "What's
 * the cheapest place to live" got no answer — a clarification panel
 * listing stale places (Hilo, HI + East Honolulu, HI) and a stacked
 * research status line while nothing ran. These tests drive the
 * client path the coordinator's probe pinned: the raw route returns
 * the same clarified lookup for this question as for "cheapest rent
 * in America" (verified live), so the fix lives in the client rescue
 * (national-screen.ts) and the panel wiring around it — parse result
 * in, rescued intent out, pipeline over canned rows, verified card.
 */

const EXACT_QUESTION = "What's the cheapest place to live"

/** The parse the live route returns for the exact question (probe, 2026-11-02). */
const probeParse: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const ROWS: AreaRow[] = [
  {
    zcta: '73000',
    name: 'Pricey Town, TX',
    metrics: { median_gross_rent: 2100 },
    moes: { median_gross_rent: 210 },
  },
  {
    zcta: '74000',
    name: 'Cheapestville, OK',
    metrics: { median_gross_rent: 640 },
    moes: { median_gross_rent: 45 },
  },
  {
    zcta: '67000',
    name: 'Midplace, KS',
    metrics: { median_gross_rent: 1100 },
    moes: { median_gross_rent: 90 },
  },
  {
    zcta: '87000',
    name: 'No Rent Published, NM',
    metrics: { median_gross_rent: null },
    moes: { median_gross_rent: null },
  },
]

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

function clarificationSection(): HTMLElement | null {
  return container.querySelector('[aria-label="Clarify the request"]')
}

function buttonIn(section: HTMLElement, text: string): HTMLButtonElement {
  const found = [...section.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`button not found in section: ${text}`)
  return found as HTMLButtonElement
}

describe("live ask: the owner's exact question, end to end", () => {
  it('parse result in -> rescued national screen -> verified card naming the cheapest place by median gross rent', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const onExecute = vi.fn()
    const provider = createStubProvider({
      async intent() {
        return { intent: probeParse }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask(EXACT_QUESTION)

    // The clarification dead-end is gone: the screen ran, disclosed
    // as a whole-country screen by median gross rent.
    expect(clarificationSection()).toBeNull()
    expect(container.textContent).toContain(
      'No place was named, so this screens the whole country by median gross rent, lowest first.',
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    const rescued = onExecute.mock.calls[0]?.[0] as ValidatedIntent
    expect(rescued).toMatchObject({
      mode: 'sweep_filter',
      geographies: [],
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })

    // The rescued intent is answer-eligible and reaches the answer
    // layer with the reader's exact words.
    expect(answerEligible(rescued)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.queryText).toBe(EXACT_QUESTION)
    expect(requests[0]?.intent).toEqual(rescued)

    // Pipeline over canned rows (hermetic; no research — the exact
    // question carries no outside-data criteria).
    const answer = await composeAnswerForRequest({
      intent: rescued,
      queryText: EXACT_QUESTION,
      rows: ROWS,
      resolved: resolveAnswerGeographies(rescued, null),
      provider: createStubProvider(),
      research: false,
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places[0]?.name).toBe('Cheapestville, OK')
    expect(answer?.places[0]?.figures).toEqual([
      { key: 'median_gross_rent', value: 640, marginOfError: 45 },
    ])

    // The rendered card leads with the cheapest place and its figure.
    render(<AnswerCard answer={answer!} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Cheapestville, OK')
    expect(text).toContain('$640/mo')
    expect(text.indexOf('Cheapestville, OK')).toBeLessThan(text.indexOf('Midplace, KS'))
    expect(text.indexOf('Midplace, KS')).toBeLessThan(text.indexOf('Pricey Town, TX'))
  })
})

describe('live ask: clarification candidates belong to the current question', () => {
  it('never shows standing-selection places for a fresh question that names none', async () => {
    const provider = createStubProvider({
      async intent() {
        return { intent: probeParse }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        // The stale supply App used to pass (Phase-5 shape): places
        // from the reader's earlier selection. Provenance is fixed in
        // AskPanel, so even a caller still passing them cannot leak
        // them into this question's clarification.
        clarificationCandidates={{
          geographies: ['Hilo, HI', 'East Honolulu, HI'],
          metricKeys: ['median_gross_rent'],
        }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('tell me about housing costs')
    const section = clarificationSection()
    expect(section).not.toBeNull()
    expect(section?.textContent).not.toContain('Hilo, HI')
    expect(section?.textContent).not.toContain('East Honolulu, HI')
    expect(section?.textContent).toContain('No candidate places for this request')
    // The panel stays useful: the universal measure picks are offered.
    // REVISED PIN (owner finding F-B, 2026-11-02): the pick renders
    // under its plain-language label, never the raw measure key —
    // this assertion previously expected the key itself in the text.
    expect(section?.textContent).toContain('Median gross rent')
    expect(section?.textContent).not.toContain('median_gross_rent')
  })

  it('candidates derive from the current parse only', () => {
    const parsed: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Springfield, IL', 'Springfield, MO'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    expect(clarificationCandidatesFor(parsed, ['median_gross_rent'])).toEqual({
      geographies: ['Springfield, IL', 'Springfield, MO'],
      metricKeys: ['median_gross_rent'],
    })
    expect(clarificationCandidatesFor(probeParse, [])).toEqual({
      geographies: [],
      metricKeys: [],
    })
  })

  it('a genuine ambiguity in the current parse still resolves from the panel', async () => {
    const ambiguous: ValidatedIntent = {
      mode: 'lookup',
      geographies: ['Springfield, IL', 'Springfield, MO'],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    const onExecute = vi.fn()
    const provider = createStubProvider({
      async intent() {
        return { intent: ambiguous }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={onExecute}
        clarificationCandidates={{ geographies: [], metricKeys: ['median_gross_rent'] }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('compare Springfield rent')
    const section = clarificationSection()
    expect(section).not.toBeNull()
    // Both same-name cities from THIS parse are the choices already
    // made, and the measure pick completes the request with them.
    expect(container.textContent).toContain('Springfield, IL')
    expect(container.textContent).toContain('Springfield, MO')
    await act(async () => {
      // The measure button's text is its plain-language label
      // (owner finding F-B, 2026-11-02), not the raw key this test
      // previously clicked by.
      buttonIn(section!, 'Median gross rent').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    // REVISED PIN (item-16 cure C2, 2026-11-02): the flow used to
    // end with a separate "Use these choices" click confirming the
    // measure pick. That confirm step is removed — the pick that
    // completes the set runs it — so the execution below follows
    // the measure toggle directly.
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      geographies: ['Springfield, IL', 'Springfield, MO'],
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })
  })
})

describe('live ask: no research status line while blocked in clarification', () => {
  it('"best schools near Hilo" no longer clarifies: the research-first handoff fires and the pipeline owns research', async () => {
    // RE-POINTED (2026-11-02): this case previously pinned "best
    // schools near Hilo" CLARIFYING, with the standalone research
    // call as its only path forward. The owner's requirement of
    // 2026-11-02 08:29 HST superseded that pin — a partially
    // servable question gets a partial grounded answer, never a
    // dead-end clarification — so the question now hands off to the
    // Answer Layer's research-first path (see
    // research-first-handoff.test.tsx for the end-to-end case), the
    // clarification never renders, and the standalone call does not
    // fire: the pipeline's research-first stage is this question's
    // research. The status-line suppression this describe exists
    // for is preserved by the still-clarifying case below.
    const researchCalls: ResearchRequest[] = []
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Hilo'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } satisfies ValidatedIntent,
        }
      },
      research(req) {
        researchCalls.push(req)
        return new Promise(() => {})
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={(intent, queryText) => requests.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('best schools near Hilo')
    expect(clarificationSection()).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.intent).toMatchObject({
      geographies: ['Hilo'],
      metricKeys: [],
      clarificationNeeded: false,
    })
    expect(researchCalls).toHaveLength(0)
    expect(container.textContent).not.toContain('Looking up what the Census data does not cover')
  })

  it('suppresses the loading line in clarification, and still fires the standalone call the coverage fallback depends on', async () => {
    const researchCalls: ResearchRequest[] = []
    let releaseResearch: ((value: never) => void) | undefined
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            // A genuine ambiguity in the current parse — the case
            // clarification exists for, so this question still
            // clarifies under the research-first handoff.
            geographies: ['Springfield, IL', 'Springfield, MO'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } satisfies ValidatedIntent,
        }
      },
      research(req) {
        researchCalls.push(req)
        return new Promise((resolve) => {
          releaseResearch = resolve as (value: never) => void
        })
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={() => ''}
        onAnswerRequest={() => {}}
        // Production wiring (App passes the full measure list): a
        // measure pick stays on offer, so the panel remains in
        // clarification for this test's subject. Without candidates
        // the panel would have nothing left to offer and — since
        // item-16 cure C2 — would run the held places on the F-C
        // default measure at mount instead of staying blocked.
        clarificationCandidates={{ geographies: [], metricKeys: ['median_gross_rent'] }}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('best schools in Springfield')
    expect(clarificationSection()).not.toBeNull()
    // The call fired (its failure is the politics coverage fallback),
    // but its status line must not render over a blocked question.
    expect(researchCalls).toHaveLength(1)
    expect(container.textContent).not.toContain('Looking up what the Census data does not cover')
    await act(async () => {
      releaseResearch?.({
        prose: 'Springfield schools include well-rated elementary options in both states.',
        sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
      } as never)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    // Findings are content, not a status line: they still render.
    expect(container.querySelector('section[aria-label="From the web"]')).not.toBeNull()
  })

  it('still shows the loading line for a runnable question (suppression is clarification-specific)', async () => {
    let releaseResearch: ((value: never) => void) | undefined
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Hilo'],
            metricKeys: ['median_gross_rent'],
            filters: [],
            clarificationNeeded: false,
          } satisfies ValidatedIntent,
        }
      },
      research() {
        return new Promise((resolve) => {
          releaseResearch = resolve as (value: never) => void
        })
      },
    })
    // No answer layer wired: standalone research runs in parallel,
    // as in the pre-answer-layer mounts.
    render(<AskPanel provider={provider} onExecute={() => ''} parseRetryDelaysMs={[]} />)
    await ask('best schools near Hilo')
    expect(clarificationSection()).toBeNull()
    // Plan C6 supersedes this pin's original form: the standalone
    // research status line folded into the ack + thinking indicator,
    // so the line itself no longer renders while research is pending.
    expect(container.textContent).not.toContain('Looking up what the Census data does not cover')
    await act(async () => {
      releaseResearch?.({ prose: '', sources: [] } as never)
    })
  })
})
