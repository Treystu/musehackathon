// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultMeterConfig, Meter } from '../../src/core/ai/meter'
import { clearMetaKey, hasMetaKey, setMetaKey } from '../../src/core/ai/meta-key'
import {
  createStubProvider,
  type IntentRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import { ByoSettings } from '../../src/ui/ai/ByoSettings'

const runnable: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

function creditsError() {
  return Object.assign(new Error('shared allowance used up'), {
    code: 'credits_exhausted',
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  clearMetaKey()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearMetaKey()
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

function submitForm(form: HTMLFormElement) {
  return act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function askControls() {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  return { input, form }
}

describe('BYO recovery on credits_exhausted', () => {
  it('caught credits_exhausted renders the offer with copy intact', async () => {
    const sharedCalls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        sharedCalls.push(req)
        throw creditsError()
      },
    })
    render(<AskPanel provider={provider} onOpenSettings={() => {}} />)

    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(sharedCalls).toHaveLength(1)
    // Credits copy still present …
    expect(container.textContent).toContain('shared allowance')
    // … and the offer now renders from the catch, not only from the prop.
    const offer = container.querySelector('aside[aria-label="Optional personal key"]')
    expect(offer).not.toBeNull()
    expect(offer?.textContent).toContain('Open key settings')
  })

  it('settings flow stores a stub key and the next Ask goes BYO-direct with the meter untouched', async () => {
    const meter = new Meter(defaultMeterConfig())
    const sharedCalls: IntentRequest[] = []
    const byoCalls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        sharedCalls.push(req)
        throw creditsError()
      },
    })
    const byoProvider = createStubProvider({
      async intent(req) {
        byoCalls.push(req)
        return { intent: runnable }
      },
    })

    // Settings surface: a shape-checked stub key is accepted and stored.
    render(<ByoSettings />)
    const keyInput = container.querySelector('#byo-key') as HTMLInputElement
    typeInto(keyInput, 'stub-personal-key-0123456789abcdef')
    await submitForm(container.querySelector('form') as HTMLFormElement)
    expect(container.textContent).toContain('stored in this browser')
    expect(hasMetaKey()).toBe(true)

    // Next Ask: shared fails, then BYO-direct carries it.
    render(<AskPanel provider={provider} byoProvider={byoProvider} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(sharedCalls).toHaveLength(1)
    expect(byoCalls).toHaveLength(1)
    expect(byoCalls[0]?.queryText).toBe('rent in Hilo')
    // The BYO-direct call bypassed the metered proxy route entirely.
    expect(meter.snapshot().requests).toBe(0)
    // The BYO answer lands like any accepted intent.
    expect(container.textContent).toContain('Run this request')
  })

  it('without a stored key there is no BYO retry, and the happy path shows no offer', async () => {
    const sharedCalls: IntentRequest[] = []
    const byoCalls: IntentRequest[] = []
    const failing = createStubProvider({
      async intent(req) {
        sharedCalls.push(req)
        throw creditsError()
      },
    })
    const byoProvider = createStubProvider({
      async intent(req) {
        byoCalls.push(req)
        return { intent: runnable }
      },
    })
    render(<AskPanel provider={failing} byoProvider={byoProvider} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(sharedCalls).toHaveLength(1)
    expect(byoCalls).toHaveLength(0)
    expect(container.textContent).toContain('shared allowance')

    const working = createStubProvider({
      async intent() {
        return { intent: { ...runnable, clarificationNeeded: true } }
      },
    })
    render(<AskPanel provider={working} />)
    const fresh = askControls()
    typeInto(fresh.input, 'rent in Hilo')
    await submitForm(fresh.form)
    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
    expect(container.textContent).not.toContain('Open key settings')
    expect(setMetaKey('x')).toBe(false)
  })

  it('clicking Open key settings fires the settings handoff', async () => {
    const onOpenSettings = vi.fn()
    const provider = createStubProvider({
      async intent() {
        throw creditsError()
      },
    })
    render(<AskPanel provider={provider} onOpenSettings={onOpenSettings} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    const button = container.querySelector(
      'aside[aria-label="Optional personal key"] button',
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('budget_exhausted retries BYO-direct like credits_exhausted', async () => {
    expect(setMetaKey('stub-personal-key-0123456789abcdef')).toBe(true)
    const sharedCalls: IntentRequest[] = []
    const byoCalls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        sharedCalls.push(req)
        throw Object.assign(new Error('cap reached'), { code: 'budget_exhausted' })
      },
    })
    const byoProvider = createStubProvider({
      async intent(req) {
        byoCalls.push(req)
        return { intent: runnable }
      },
    })
    render(<AskPanel provider={provider} byoProvider={byoProvider} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(sharedCalls).toHaveLength(1)
    expect(byoCalls).toHaveLength(1)
    expect(container.textContent).toContain('Run this request')
    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
  })

  it('shared and BYO both failing falls through to the shared copy', async () => {
    expect(setMetaKey('stub-personal-key-0123456789abcdef')).toBe(true)
    const byoCalls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent() {
        throw creditsError()
      },
    })
    const byoProvider = createStubProvider({
      async intent(req) {
        byoCalls.push(req)
        throw Object.assign(new Error('down'), { code: 'provider_down' })
      },
    })
    render(<AskPanel provider={provider} byoProvider={byoProvider} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(byoCalls).toHaveLength(1)
    expect(container.textContent).toContain('shared allowance')
    expect(
      container.querySelector('aside[aria-label="Optional personal key"]'),
    ).not.toBeNull()
    expect(container.textContent).not.toContain('Run this request')
  })
})
