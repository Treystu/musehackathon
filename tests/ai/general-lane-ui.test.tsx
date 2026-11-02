// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GENERAL_ANSWER_LABEL,
  INQUIRY_WAVE_OFF_CLOSE,
  OPEN_INQUIRY_TEXT,
  markInquiryAsked,
  resetInquirySessionForTests,
} from '../../src/core/ai/general'
import {
  createStubProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { GeneralAnswer } from '../../src/ui/ai/GeneralAnswer'
import type { GeneralAnswerData } from '../../src/ui/ai/general-runner'
import { AnswerCard } from '../../src/ui/ai/AnswerCard'
import type { ComposedAnswer } from '../../src/core/ai/answer'

/**
 * P5 general lane UI pins (battery cluster E, hermetic): an
 * off-domain parse reaches the general lane and never the
 * clarification panel (E1/E3/E5), a hybrid routes BOTH parts (E6),
 * a substantive reply after the inquiry routes as a first-class
 * request (E7), a wave-off closes gracefully with no parse (E9),
 * and the render-level validator-separation pair: a general answer
 * renders under the general label with its numerals intact, and a
 * data answer (AnswerCard) carries no general label anywhere.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetInquirySessionForTests()
  sessionStorage.clear()
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

function offDomainIntent(partial: Partial<ValidatedIntent> = {}): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: true,
    domain: 'off_domain',
    ...partial,
  }
}

describe('AskPanel general-lane routing', () => {
  it('E1: marbles route to the general lane, never the clarification panel', async () => {
    const general: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: offDomainIntent() }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onGeneralRequest={(intent, queryText) => general.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('How many marbles would it take to fill the moon?')
    expect(general).toHaveLength(1)
    expect(general[0]?.queryText).toBe('How many marbles would it take to fill the moon?')
    expect(general[0]?.intent.domain).toBe('off_domain')
    expect(clarificationSection()).toBeNull()
    expect(container.textContent).not.toContain('More detail is needed before anything runs')
  })

  it('E3 + E5: a joke and "What can you do?" route to the general lane too', async () => {
    const general: string[] = []
    const provider = createStubProvider({
      async intent() {
        return { intent: offDomainIntent() }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onGeneralRequest={(_intent, queryText) => general.push(queryText)}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('Tell me a joke about moving house.')
    await ask('What can you do?')
    expect(general).toEqual(['Tell me a joke about moving house.', 'What can you do?'])
    expect(clarificationSection()).toBeNull()
  })

  it('E6: a hybrid routes the estimate to the general lane AND the Census part to the data path', async () => {
    const general: string[] = []
    const answers: { intent: ValidatedIntent; queryText: string }[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: offDomainIntent({
            geographies: ['Hilo, HI'],
            metricKeys: ['average_household_size'],
          }),
        }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onGeneralRequest={(_intent, queryText) => general.push(queryText)}
        onAnswerRequest={(intent, queryText) => answers.push({ intent, queryText })}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask('How many marbles would fit in a typical house in Hilo?')
    expect(general).toEqual(['How many marbles would fit in a typical house in Hilo?'])
    expect(answers).toHaveLength(1)
    expect(answers[0]?.intent.domain).toBe('data_with_gaps')
    expect(answers[0]?.intent.geographies).toEqual(['Hilo, HI'])
    expect(answers[0]?.intent.metricKeys).toEqual(['average_household_size'])
  })

  it('E7: after the inquiry, a substantive reply routes through the normal pipeline', async () => {
    markInquiryAsked()
    const answers: string[] = []
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'sweep_filter',
            geographies: [],
            metricKeys: ['median_gross_rent'],
            filters: [],
            clarificationNeeded: false,
            domain: 'data_with_gaps',
          } as ValidatedIntent,
        }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onAnswerRequest={(_intent, queryText) => answers.push(queryText)}
        parseRetryDelaysMs={[]}
      />,
    )
    await ask("honestly I'm thinking about moving somewhere quieter")
    expect(answers).toEqual(["honestly I'm thinking about moving somewhere quieter"])
    expect(container.textContent).not.toContain(INQUIRY_WAVE_OFF_CLOSE)
  })

  it('E9: a wave-off reply closes gracefully — no parse, no panel, no second inquiry', async () => {
    markInquiryAsked()
    const intentSpy = vi.fn(async () => ({ intent: offDomainIntent() }))
    const provider = createStubProvider({ intent: intentSpy })
    render(<AskPanel provider={provider} parseRetryDelaysMs={[]} />)
    await ask('nope, just curious')
    expect(intentSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain(INQUIRY_WAVE_OFF_CLOSE)
    expect(clarificationSection()).toBeNull()
  })
})

const GENERAL_DATA: GeneralAnswerData = {
  proseClass: 'general',
  label: GENERAL_ANSWER_LABEL,
  text: 'About 2.7e25 marbles. The derivation is stated in one breath, with its assumptions in a clause.',
  precisionLimit: null,
  arithmetic: { checked: 1, failures: [], passed: true },
  jev: { ran: true, accuracy: 0.99, relevance: 0.95, roundsUsed: 0 },
  inquiry: { kind: 'open', text: OPEN_INQUIRY_TEXT },
  timings: {},
}

describe('GeneralAnswer rendering + validator separation pair', () => {
  it('a general answer renders under the general label, numerals intact, exactly one inquiry', () => {
    render(<GeneralAnswer answer={GENERAL_DATA} />)
    const section = container.querySelector('[data-prose-class="general"]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain(GENERAL_ANSWER_LABEL)
    expect(section?.textContent).toContain('2.7e25')
    expect(container.querySelectorAll('[data-inquiry]')).toHaveLength(1)
  })

  it('a data answer cannot render under the general label', () => {
    const dataAnswer = {
      status: 'verified',
      stage: 'verify',
      criteria: [],
      droppedCriteria: [],
      unresolvedGeographies: [],
      screenedCount: 0,
      places: [],
      generalClaims: [],
      sources: [],
      summary: 'No stated criteria.',
      droppedClaims: [],
      failures: [],
      researchCriteria: [],
      criterionEvidence: [],
      candidateCap: 10,
      candidateCapApplied: false,
      unresolvedCandidates: [],
      geographyLevel: 'place',
      unsupportedGeography: null,
      countyMethod: null,
      notMeasurableCounties: [],
    } as unknown as ComposedAnswer
    render(<AnswerCard answer={dataAnswer} />)
    expect(container.textContent).not.toContain(GENERAL_ANSWER_LABEL)
    expect(container.querySelector('[data-prose-class="general"]')).toBeNull()
  })
})
