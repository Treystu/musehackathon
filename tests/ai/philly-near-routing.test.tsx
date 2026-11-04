// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStubProvider } from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'

/**
 * Near-frame round 2 at the panel seam (measured live on
 * production 6151d0c, 2026-11-03): the specimen's phrasing parsed
 * as similarity, and the label decided the whole route —
 * answerEligible excludes similarity, so no answer request was
 * registered and the frame never engaged, while execution opened
 * the similar-ZIP search on the anchor itself. These pins hold
 * the accept seam's discrimination: a similarity label carrying
 * the frame's signal set (one anchor place, a stated radius or
 * near phrase, no likeness predicate) is re-routed to the frame's
 * lookup shape and registered with the answer layer; genuine
 * similarity questions keep the similarity route exactly.
 */

const SPECIMEN =
  'where near philadelphia has good schools and lower cost of living, within 20 miles (as compared to philadelphia itself).'

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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(form: HTMLFormElement) {
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function askWithParse(question: string, parse: Record<string, unknown>) {
  const research = vi.fn(async () => ({ prose: '', sources: [] }))
  const provider = createStubProvider({
    async intent() {
      return { intent: parse as never }
    },
    research,
  })
  const onExecute = vi.fn()
  const onAnswerRequest = vi.fn()
  render(<AskPanel provider={provider} onExecute={onExecute} onAnswerRequest={onAnswerRequest} />)
  typeInto(container.querySelector('#ask-input') as HTMLInputElement, question)
  await submit(container.querySelector('form') as HTMLFormElement)
  return { onExecute, onAnswerRequest, research }
}

const SIMILARITY_PARSE = {
  mode: 'similarity',
  geographies: ['Philadelphia, PA'],
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}

describe('the specimen under a similarity label', () => {
  it('re-routes to the frame: execution and the answer layer both receive the lookup shape', async () => {
    const { onExecute, onAnswerRequest, research } = await askWithParse(SPECIMEN, SIMILARITY_PARSE)
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      mode: 'lookup',
      geographies: ['Philadelphia, PA'],
      metricKeys: ['median_gross_rent', 'median_home_value'],
      clarificationNeeded: false,
    })
    // The answer layer is registered — the route the live run never took.
    expect(onAnswerRequest).toHaveBeenCalledTimes(1)
    expect(onAnswerRequest.mock.calls[0]?.[0]).toMatchObject({ mode: 'lookup' })
    expect(onAnswerRequest.mock.calls[0]?.[1]).toBe(SPECIMEN)
    // Research hands to the pipeline, never the standalone web path.
    expect(research).not.toHaveBeenCalled()
    // The reading is disclosed, and nothing clarifies.
    expect(container.textContent).toContain('This screens the places near Philadelphia, PA')
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
  })

  it('completes the measures when the similarity parse carries none', async () => {
    // A measure-less parse can only arrive clarifying (validateIntent
    // requires a measure on any settled intent); withRunnability
    // settles it at accept because similarity can run measure-less —
    // the re-route is what gives the frame's screen its measures.
    const { onAnswerRequest } = await askWithParse(SPECIMEN, {
      ...SIMILARITY_PARSE,
      metricKeys: [],
      clarificationNeeded: true,
    })
    expect(onAnswerRequest).toHaveBeenCalledTimes(1)
    const intent = onAnswerRequest.mock.calls[0]?.[0] as { mode: string; metricKeys: string[] }
    expect(intent.mode).toBe('lookup')
    expect(intent.metricKeys).toContain('median_gross_rent')
  })
})

describe('genuine similarity questions keep their lane', () => {
  it('"places similar to Philadelphia" executes as similarity and registers no answer', async () => {
    const { onExecute, onAnswerRequest } = await askWithParse(
      'places similar to Philadelphia',
      SIMILARITY_PARSE,
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ mode: 'similarity' })
    expect(onAnswerRequest).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('This screens the places near')
  })

  it('"towns like Philadelphia for retirees" executes as similarity and registers no answer', async () => {
    const { onExecute, onAnswerRequest } = await askWithParse(
      'towns like Philadelphia for retirees',
      SIMILARITY_PARSE,
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ mode: 'similarity' })
    expect(onAnswerRequest).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('This screens the places near')
  })
})

describe('the plain lookup shape is untouched', () => {
  it('a lookup parse of the anchor runs verbatim, with no re-route note', async () => {
    const { onExecute, onAnswerRequest } = await askWithParse(
      'What is the median rent in Philadelphia, PA?',
      {
        mode: 'lookup',
        geographies: ['Philadelphia, PA'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      },
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      mode: 'lookup',
      metricKeys: ['median_gross_rent'],
    })
    expect(onAnswerRequest).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('This screens the places near')
  })
})
