// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStubProvider } from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'

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

describe('national screen at the Ask surface', () => {
  it('rescues even when the model reply fails shape validation', async () => {
    // Observed live 2026-11-01: for "where is the cheapest rent in
    // America?" one reply came back in a shape validateIntent rejects.
    // The rescue reads the reader's words, not the reply, so the screen
    // is still offered — disclosed, and behind the Run button.
    const provider = createStubProvider({
      async intent() {
        return { intent: { mode: 'sweep_filter', geographies: 'America' } as never }
      },
    })
    const onExecute = vi.fn()
    render(<AskPanel provider={provider} onExecute={onExecute} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'where is the cheapest rent in America?')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.textContent).toContain(
      'No place was named, so this screens the whole country by median gross rent, lowest first.',
    )
    // Auto-run: the rescued screen executes on submit; there is no Run button.
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      mode: 'sweep_filter',
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
  })

  it('rescues the live reply shape: a valid clarified intent naming neither place nor measure', async () => {
    // The shape the live route returns for this query (observed
    // 2026-11-01, three consecutive probes): a valid lookup intent,
    // clarified, with empty geographies and metricKeys. The rescue must
    // fire on the valid path too, not only on the shape-invalid path.
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: [],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } as never,
        }
      },
    })
    const onExecute = vi.fn()
    render(<AskPanel provider={provider} onExecute={onExecute} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'where is the cheapest rent in America?')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.textContent).toContain(
      'No place was named, so this screens the whole country by median gross rent, lowest first.',
    )
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      mode: 'sweep_filter',
      metricKeys: ['median_gross_rent'],
      clarificationNeeded: false,
    })
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
  })

  it('names the politics coverage gap plainly when a question asks for one', async () => {
    // The owner's example (2026-11-01): a move-to-Nevada question
    // asking for somewhere "not Republican". The parse clarifies for
    // a measure; the panel must also say, in plain words, that the
    // politics part is outside this Census data — never silently
    // dropped and never screened on invented data.
    const provider = createStubProvider({
      async intent() {
        return {
          intent: {
            mode: 'lookup',
            geographies: ['NV'],
            metricKeys: [],
            filters: [],
            clarificationNeeded: true,
          } as never,
        }
      },
    })
    const onExecute = vi.fn()
    render(<AskPanel provider={provider} onExecute={onExecute} />)
    typeInto(
      container.querySelector('#ask-input') as HTMLInputElement,
      'I live in El Paso and want to move somewhere in Nevada that is not Republican, somewhere liberal',
    )
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.textContent).toContain('no voter registration, party affiliation, or election results')
    expect(container.querySelector('[aria-label="Clarify the request"]')).not.toBeNull()
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('does not rescue a shape-invalid reply for an ordinary question', async () => {
    const provider = createStubProvider({
      async intent() {
        return { intent: { mode: 'sweep_filter', geographies: 'America' } as never }
      },
    })
    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'what is the rent in Austin?')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.textContent).toContain('That request cannot be run as asked.')
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
  })
})
