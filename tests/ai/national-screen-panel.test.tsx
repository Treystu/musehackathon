// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    render(<AskPanel provider={provider} />)
    typeInto(container.querySelector('#ask-input') as HTMLInputElement, 'where is the cheapest rent in America?')
    await submit(container.querySelector('form') as HTMLFormElement)

    expect(container.textContent).toContain(
      'No place was named, so this screens the whole country by median gross rent, lowest first.',
    )
    const run = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run this request',
    )
    expect(run).toBeDefined()
    expect(container.querySelector('[aria-label="Clarify the request"]')).toBeNull()
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
