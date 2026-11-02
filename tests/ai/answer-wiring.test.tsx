// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createStubProvider,
  type ResearchRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel, answerEligible } from '../../src/ui/ai/AskPanel'

/**
 * Answer-layer wiring in the Ask flow (2026-11-02): a runnable,
 * answer-eligible intent is handed to the answer layer with the
 * reader's original question text, and the pipeline owns research
 * for it — the panel's standalone research is deferred past the
 * parse and fires only for questions the pipeline will not serve,
 * so one question never spends two research calls.
 */
const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: [],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

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

describe('answerEligible', () => {
  it('covers sweeps, filtered intents, and place lookups — not similarity or clarification shapes', () => {
    expect(answerEligible(sweepIntent)).toBe(true)
    expect(
      answerEligible({
        mode: 'lookup',
        geographies: ['Hilo'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(true)
    expect(
      answerEligible({
        mode: 'similarity',
        geographies: ['96778'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
    expect(
      answerEligible({
        mode: 'lookup',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }),
    ).toBe(false)
  })
})

describe('AskPanel answer wiring', () => {
  it('hands an eligible intent and the original question text to the answer layer, and does not also fire standalone research', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const researchCalls: ResearchRequest[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: sweepIntent }
      },
      async research(req) {
        researchCalls.push(req)
        return { prose: 'x', sources: [{ title: 't', url: 'https://example.org' }] }
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
    await ask('places with good schools where rent is under $1,500 a month')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.queryText).toBe('places with good schools where rent is under $1,500 a month')
    expect(requests[0]!.intent).toMatchObject({ mode: 'sweep_filter' })
    expect(requests[0]!.intent.filters).toEqual([
      { metricKey: 'median_gross_rent', op: 'lt', value: 1500 },
    ])
    // The pipeline owns research for this question; the standalone
    // path stays silent, so there is no second "From the web" section.
    expect(researchCalls).toHaveLength(0)
    expect(container.querySelector('section[aria-label="From the web"]')).toBeNull()
  })

  it('a plain lookup hands over too, with the question text verbatim', async () => {
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['Austin, TX'],
            metricKeys: ['median_home_value'],
            filters: [],
            clarificationNeeded: false,
          } satisfies ValidatedIntent,
        }
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
    await ask('What is the median home value in Austin, Texas?')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.queryText).toBe('What is the median home value in Austin, Texas?')
    expect(requests[0]!.intent).toMatchObject({ mode: 'lookup', geographies: ['Austin, TX'] })
  })

  it('an external-only clarification now hands off to the pipeline instead of the standalone path', async () => {
    // RE-POINTED (2026-11-02): this case previously pinned "best
    // schools near Hilo" as a question the pipeline cannot serve —
    // clarification, no answer request, standalone research as the
    // fallback. The owner's requirement of 2026-11-02 08:29 HST (a
    // partially servable question gets a partial grounded answer,
    // never a dead-end clarification) superseded that pin: the
    // pipeline's research-first path serves exactly this shape, so
    // the handoff fires and the pipeline owns research. The
    // standalone fallback survives for clarifications that stay
    // clarifications — the next case.
    const requests: { intent: ValidatedIntent; queryText: string }[] = []
    const researchCalls: ResearchRequest[] = []
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
      async research(req) {
        researchCalls.push(req)
        return {
          prose: 'Hilo schools include well-rated elementary options.',
          sources: [{ title: 'Hawaii DOE', url: 'https://example.org/doe' }],
        }
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
    expect(requests).toHaveLength(1)
    expect(requests[0]?.queryText).toBe('best schools near Hilo')
    expect(requests[0]?.intent).toMatchObject({
      geographies: ['Hilo'],
      clarificationNeeded: false,
    })
    expect(researchCalls).toHaveLength(0)
  })

  it('a clarification that stays a clarification still gets the standalone research path', async () => {
    const requests: unknown[] = []
    const researchCalls: ResearchRequest[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            // Genuine ambiguity in the current parse: the handoff
            // discriminator leaves this with the clarification panel.
            geographies: ['Springfield, IL', 'Springfield, MO'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } satisfies ValidatedIntent,
        }
      },
      async research(req) {
        researchCalls.push(req)
        return {
          prose: 'Springfield schools include well-rated options in both states.',
          sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
        }
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
    await ask('best schools in Springfield')
    // Clarification stands: nothing ran, so no answer request — and
    // the deferred standalone research fires as the fallback.
    expect(requests).toHaveLength(0)
    expect(researchCalls).toHaveLength(1)
    const section = container.querySelector('section[aria-label="From the web"]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain('Springfield schools include')
  })

})
