// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CENSUS_KEY_EVENT,
  CENSUS_KEY_STORAGE_KEY,
  clearCensusKey,
  setCensusKey,
} from '../../src/core/ai/census-key'
import { clearMetaKey, setMetaKey } from '../../src/core/ai/meta-key'
import { createStubProvider } from '../../src/core/ai/provider'
import { AgentHandoff } from '../../src/ui/ai/AgentHandoff'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { OnboardingWizard } from '../../src/ui/ai/OnboardingWizard'

// Clearly-fake placeholders, assembled from short segments so no literal
// in this file resembles a real credential.
const fakeCensusKey = ['0123456789abcdef', '0123456789abcdef', '01234567'].join('')
const fakeMetaKey = ['test', 'key', 'abcd', '1234'].join('-')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  clearCensusKey()
  clearMetaKey()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearCensusKey()
  clearMetaKey()
  localStorage.clear()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush() {
  await act(async () => {})
}

function clickButton(text: string) {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!btn) throw new Error(`button not found: ${text}`)
  act(() => btn.click())
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitFormOf(input: HTMLInputElement) {
  const form = input.closest('form')
  if (!form) throw new Error('input is not in a form')
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function statusList(): string {
  const list = container.querySelector('[aria-label="Key setup status"]')
  return list?.textContent ?? ''
}

describe('mounting: the wizard is reachable from the app surface', () => {
  it('AskPanel renders the "Set up with your agent" entry point and the manual path opens the wizard', async () => {
    render(<AskPanel provider={createStubProvider()} />)
    await flush()
    expect(container.textContent).toContain('Set up with your agent')
    expect(container.textContent).toContain('Census API key: not set up yet.')
    expect(container.textContent).not.toContain('Getting started')

    clickButton('Continue manually instead')
    expect(container.textContent).toContain('Getting started')
    expect(container.textContent).toContain('Independent-run check: AWAITING')
    expect(container.textContent).not.toContain('PASSED')
  })

  it('a handoff lands the manual path on the equivalent step', async () => {
    render(<AgentHandoff manualEquivalent="manual:census-paste-key" />)
    await flush()
    clickButton('Continue manually instead')
    expect(container.textContent).toContain('Step 3 of 4: Your keys')
  })
})

describe('confirmation comes from the app re-validation event, never a claim', () => {
  it('flips only when the app stores the key through its own module', async () => {
    render(<AgentHandoff />)
    await flush()
    expect(statusList()).toContain('Census API key: not set up yet.')

    // Writing storage directly — no app event — confirms nothing.
    act(() => {
      localStorage.setItem(CENSUS_KEY_STORAGE_KEY, fakeCensusKey)
    })
    await flush()
    expect(statusList()).toContain('Census API key: not set up yet.')

    // The app module storing the key dispatches the event; the surface
    // re-reads and confirms.
    act(() => {
      setCensusKey(fakeCensusKey)
    })
    await flush()
    expect(statusList()).toContain('Census API key: confirmed by the app in this browser.')
    expect(statusList()).toContain('Personal key (optional): not set up yet.')

    act(() => {
      clearCensusKey()
    })
    await flush()
    expect(statusList()).toContain('Census API key: not set up yet.')
  })

  it('never shows success when the app re-check rejects the stored key', async () => {
    const metaFetcher = vi.fn(async () => ({ ok: false }))
    render(<AgentHandoff metaFetcher={metaFetcher} />)
    await flush()

    act(() => {
      setMetaKey(fakeMetaKey)
    })
    await flush()
    // The store event fired, the re-check ran, and it said no.
    expect(metaFetcher).toHaveBeenCalled()
    expect(statusList()).toContain("Personal key (optional): stored, but the app's re-check did not accept it.")
    expect(statusList()).not.toContain('Personal key (optional): confirmed')
  })

  it('confirms after the event when the re-check passes', async () => {
    const censusFetcher = vi.fn(async () => ({ ok: true, bodyValid: true }))
    render(<AgentHandoff censusFetcher={censusFetcher} />)
    await flush()
    act(() => {
      setCensusKey(fakeCensusKey)
    })
    await flush()
    expect(censusFetcher).toHaveBeenCalledWith(fakeCensusKey)
    expect(statusList()).toContain('Census API key: confirmed by the app in this browser.')
  })
})

describe('wizard keys step covers both key paths', () => {
  it('walks what -> privacy -> keys and confirms both keys through the event loop', async () => {
    const censusFetcher = vi.fn(async () => ({ ok: true, bodyValid: true }))
    const metaFetcher = vi.fn(async () => ({ ok: true }))
    render(
      <OnboardingWizard censusFetcher={censusFetcher} metaFetcher={metaFetcher} />,
    )
    await flush()

    const ack = () => {
      const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      act(() => box.click())
    }
    ack()
    clickButton('Next')
    expect(container.textContent).toContain('Step 2 of 4: What is counted and sent')
    ack()
    clickButton('Next')
    expect(container.textContent).toContain('Step 3 of 4: Your keys')

    // Both settings surfaces and the confirmation list are on this step.
    const censusInput = container.querySelector('#census-key') as HTMLInputElement
    const metaInput = container.querySelector('#byo-key') as HTMLInputElement
    expect(censusInput).not.toBeNull()
    expect(metaInput).not.toBeNull()
    expect(statusList()).toContain('Census API key: not set up yet.')

    typeInto(censusInput, `Your key is ${fakeCensusKey}`)
    await submitFormOf(censusInput)
    await flush()
    expect(container.textContent).toContain('The key was accepted and stored in this browser.')
    expect(statusList()).toContain('Census API key: confirmed by the app in this browser.')

    typeInto(metaInput, fakeMetaKey)
    await submitFormOf(metaInput)
    await flush()
    expect(statusList()).toContain('Personal key (optional): confirmed by the app in this browser.')

    // Keys are optional: the wizard still finishes from here.
    clickButton('Next')
    expect(container.textContent).toContain('Step 4 of 4: You are ready')
    clickButton('Finish')
    expect(container.textContent).toContain('Setup complete.')
  })

  it('keeps the census event name stable for workflow consumers', () => {
    expect(CENSUS_KEY_EVENT).toBe('civicscope:census-key')
  })
})
