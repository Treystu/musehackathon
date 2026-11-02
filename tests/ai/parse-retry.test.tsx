// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createStubProvider,
  type IntentRequest,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'

/**
 * Patient parse retry (2026-11-01, owner-reported: no prompt had ever
 * completed for the owner because each attempt landed inside a flap
 * window and failed on the spot). Retryable failures — the shared
 * helper's breaker pause, provider_down, rate_limited — wait out the
 * window inside runQuery; anything else fails immediately.
 */
const runnable: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

function codedError(code: string) {
  return Object.assign(new Error(code), { code })
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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function ask(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  typeInto(input, text)
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  // The retry waits are real timers; React's act returns before they
  // fire, so settle briefly before asserting on the outcome.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

describe('patient parse retry', () => {
  it('a breaker pause that clears is waited out: the question runs', async () => {
    const calls: IntentRequest[] = []
    const executed: ValidatedIntent[] = []
    const provider = createStubProvider({
      async intent(req) {
        calls.push(req)
        if (calls.length < 3) throw codedError('breaker_open')
        return { intent: runnable }
      },
    })
    render(
      <AskPanel
        provider={provider}
        onExecute={(intent) => executed.push(intent)}
        parseRetryDelaysMs={[1, 1, 1]}
      />,
    )
    await ask('rent in Hilo')
    expect(calls).toHaveLength(3)
    expect(executed).toHaveLength(1)
    expect(executed[0]?.geographies).toEqual(['Hilo'])
  })

  it('a pause that never clears ends on the honest paused copy after the full schedule', async () => {
    const calls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        calls.push(req)
        throw codedError('breaker_open')
      },
    })
    render(<AskPanel provider={provider} parseRetryDelaysMs={[1, 1]} />)
    await ask('rent in Hilo')
    expect(calls).toHaveLength(3) // first attempt + 2 retries
    expect(container.textContent).toContain('paused after repeated problems')
  })

  it('a non-retryable failure is not retried', async () => {
    const calls: IntentRequest[] = []
    const provider = createStubProvider({
      async intent(req) {
        calls.push(req)
        throw codedError('bad_key')
      },
    })
    render(<AskPanel provider={provider} parseRetryDelaysMs={[1, 1, 1]} />)
    await ask('rent in Hilo')
    expect(calls).toHaveLength(1)
  })
})
