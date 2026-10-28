// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStubProvider,
  type IntentRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { realValidator } from '../../src/core/ai/validator'
import { AskPanel, RAW_TEXT_DISCLOSURE } from '../../src/ui/ai/AskPanel'
import { ExplainOnAsk } from '../../src/ui/ai/ExplainOnAsk'
import type { FigureInput } from '../../src/ui/ai/FigureCard'

const base: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const figure: FigureInput = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  source: 'ACS 5-year estimates',
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS',
  table: 'B25064',
  vintage: '2023',
  derivation: 'rent = annual rent / 12',
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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set
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

describe('spec-gap surfaces', () => {
  it('shows the raw-text notice before the typed text leaves for the provider', async () => {
    const calls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        calls.push(req)
        return {
          intent: { ...base, clarificationNeeded: true },
        }
      },
    })

    render(<AskPanel provider={provider} />)

    const notice = container.querySelector('#ask-raw-text-note')
    expect(notice?.textContent).toBe(RAW_TEXT_DISCLOSURE)
    expect(container.textContent).toContain(RAW_TEXT_DISCLOSURE)

    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.getAttribute('aria-describedby')).toBe('ask-raw-text-note')
    typeInto(input, 'rent in Hilo')
    expect(calls).toHaveLength(0)

    const form = container.querySelector('form') as HTMLFormElement
    await submit(form)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.queryText).toBe('rent in Hilo')
    expect(container.textContent).toContain(RAW_TEXT_DISCLOSURE)
  })

  it('removing every place chip returns Ask to clarification and hides Run', async () => {
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            ...base,
            geographies: ['Hilo', 'Honolulu'],
            clarificationNeeded: false,
          },
        }
      },
    })

    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent')
    await submit(container.querySelector('form') as HTMLFormElement)

    const removeHilo = container.querySelector(
      'button[aria-label="Remove place Hilo"]',
    ) as HTMLButtonElement
    expect(removeHilo).not.toBeNull()
    act(() => removeHilo.click())

    const removeHonolulu = container.querySelector(
      'button[aria-label="Remove place Honolulu"]',
    ) as HTMLButtonElement
    expect(removeHonolulu).not.toBeNull()
    act(() => removeHonolulu.click())

    expect(container.querySelector('[aria-label="Clarify the request"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'Choose the place and measure before anything runs.',
    )
    const run = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(run).toBeUndefined()
  })

  it('removing the only measure returns Ask to clarification and hides Run', async () => {
    const provider = createStubProvider({
      async intent() {
        return { intent: { ...base, clarificationNeeded: false } }
      },
    })

    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent in Hilo')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    const runBefore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(runBefore).toBeDefined()

    const removeMeasure = container.querySelector(
      'button[aria-label="Remove measure median_gross_rent"]',
    ) as HTMLButtonElement
    expect(removeMeasure).not.toBeNull()
    act(() => removeMeasure.click())

    expect(container.querySelector('[aria-label="Clarify the request"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'Choose the place and measure before anything runs.',
    )
    const runAfter = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(runAfter).toBeUndefined()
  })

  it('removing one of two measures keeps Run and shows no clarification', async () => {
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            ...base,
            metricKeys: ['median_gross_rent', 'median_household_income'],
            clarificationNeeded: false,
          },
        }
      },
    })

    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent and income in Hilo')
    await submit(container.querySelector('form') as HTMLFormElement)

    const removeMeasure = container.querySelector(
      'button[aria-label="Remove measure median_gross_rent"]',
    ) as HTMLButtonElement
    expect(removeMeasure).not.toBeNull()
    act(() => removeMeasure.click())

    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    const run = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(run).toBeDefined()
  })

  it('provider flag-true with full data still offers Run after submit', async () => {
    const provider = createStubProvider({
      async intent() {
        return { intent: { ...base, clarificationNeeded: true } }
      },
    })

    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'rent in Hilo')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
    const run = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(run).toBeDefined()
  })

  it('a 15 percent figure renders value and wording, not a withholding note', () => {
    const burden: FigureInput = {
      key: 'median_rent_burden_pct',
      value: 15,
      marginOfError: 2,
      source: 'ACS 5-year estimates',
      publisher: 'U.S. Census Bureau',
      dataset: 'ACS',
      table: 'S2503',
      vintage: '2023',
    }
    const prose = 'The rent burden is 15 percent.'
    const verdict = realValidator.validate(prose, [
      { key: 'median_rent_burden_pct', value: 15, marginOfError: 2 },
    ])
    expect(verdict.pass).toBe(true)
    render(
      <ExplainOnAsk
        intent={base}
        figures={[burden]}
        explanation={{ prose, withheld: !verdict.pass }}
      />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('15')
    expect(text).toContain('± 2')
    expect(text).not.toContain('withheld')
  })

  it('clicking Explain then withholding shows figures, provenance, and the note', () => {
    const onExplain = vi.fn()
    render(
      <ExplainOnAsk intent={base} figures={[figure]} onExplain={onExplain} />,
    )

    const button = container.querySelector('button') as HTMLButtonElement
    act(() => button.click())
    expect(onExplain).toHaveBeenCalledTimes(1)
    expect(onExplain).toHaveBeenCalledWith(base)
    expect(container.textContent).not.toContain('Explanation withheld')

    render(
      <ExplainOnAsk
        intent={base}
        figures={[figure]}
        explanation={{ prose: 'Invented 9999', withheld: true }}
      />,
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Explanation withheld')
    expect(text).toContain('1,450')
    expect(text).toContain('± 85')
    expect(text).toContain('ACS 5-year estimates')
    expect(text).toContain('U.S. Census Bureau')
    expect(text).toContain('B25064')
    expect(text).toContain('2023')
    expect(text).toContain('How this figure was derived')
    expect(text).toContain('rent = annual rent / 12')
    expect(text).not.toContain('Invented 9999')
  })
})
