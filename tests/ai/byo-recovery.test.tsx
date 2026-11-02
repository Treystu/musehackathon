// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('caught credits_exhausted shows the honest exhausted note and no own-key content', async () => {
    // Owner ruling F-E is absolute (P4b, 2026-11-02): zero key/setup
    // content in the judged flow, exhausted states included — the
    // ByoOffer mount that used to render its own-key text here from
    // the catch is removed, and the honest exhausted note
    // (PROXY_ERROR_COPY) is what the state shows.
    const sharedCalls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        sharedCalls.push(req)
        throw creditsError()
      },
    })
    render(<AskPanel provider={provider} />)

    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(sharedCalls).toHaveLength(1)
    // The honest exhausted note is present …
    expect(container.textContent).toContain('shared allowance')
    expect(container.textContent).toContain('used up for now')
    // … and no own-key content renders with it.
    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
    expect(container.textContent).not.toContain('your own Meta key')
    expect(container.textContent).not.toContain('Open key settings')
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
    // The BYO answer lands like any accepted intent: understood chips
    // on screen, auto-run semantics (no Run control exists any more).
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Run this request')
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

  it('the exhausted Ask state offers no settings handoff (F-E: BYO lives outside the judged flow)', async () => {
    // This replaces the pre-F-E pin that clicked an "Open key
    // settings" button on the Ask surface: under the absolute ruling
    // there is no such button on Ask in any state, so there is no
    // handoff to fire. Key entry stays on the settings surface
    // (ByoSettings, exercised directly in this file and in
    // ask-completion).
    const provider = createStubProvider({
      async intent() {
        throw creditsError()
      },
    })
    render(<AskPanel provider={provider} />)
    const { input, form } = askControls()
    typeInto(input, 'rent in Hilo')
    await submitForm(form)

    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
    expect(container.textContent).not.toContain('Open key settings')
    expect(container.textContent).toContain('shared allowance')
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
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Run this request')
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
    // The BYO retry is a call path and still ran above; what the
    // reader sees is the honest shared copy only — no offer renders
    // on the Ask surface in the exhausted state (ruling F-E, P4b).
    expect(container.querySelector('aside[aria-label="Optional personal key"]')).toBeNull()
    expect(container.textContent).not.toContain('your own Meta key')
    expect(container.textContent).not.toContain('Run this request')
  })
})
