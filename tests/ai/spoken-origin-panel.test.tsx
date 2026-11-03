// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grantMicConsent, type MicStorage } from '../../src/core/ai/mic'
import {
  createStubProvider,
  type MuseProvider,
  type TranscribeResult,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { AskPanel } from '../../src/ui/ai/AskPanel'
import type { AnswerRequestOrigin } from '../../src/ui/ai/session-store'
import type {
  MicRecognitionHandlers,
  MicRecognizer,
} from '../../src/ui/ai/MicInput'

/**
 * Lane A8 — the origin fact at its creation seam (the mic-ui
 * pattern: the real panel, a fake recognizer, a stub provider).
 * runQuery is the single funnel every run-start vector passes
 * through, and the fact is exact there: 'voice' only for the ask an
 * accepted mic transcript created, 'typed' for the form submit and
 * the example chips. App stamps the fact onto the minted request;
 * the stamp — not the ambient voice-mode flag — gates speech.
 */

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

function fakeStorage(): MicStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function fakeRecognizer() {
  let handlers: MicRecognitionHandlers | null = null
  const recognizer: MicRecognizer = {
    async start(h) {
      handlers = h
    },
    abort() {},
  }
  const emit = {
    async final(result: TranscribeResult) {
      await act(async () => handlers?.onFinal(result))
    },
  }
  return { recognizer, emit }
}

const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
  clarificationNeeded: false,
}

function provider(): MuseProvider {
  return createStubProvider({
    async intent() {
      return { intent: sweepIntent }
    },
  })
}

function render(node: ReactNode) {
  act(() => root.render(node))
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
  if (!found) throw new Error(`button not found: ${text}`)
  return found as HTMLButtonElement
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the ask origin fact (onAskStart)', () => {
  it('an accepted mic transcript creates a voice ask', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    grantMicConsent(storage)
    const askStarts: Array<[string, AnswerRequestOrigin]> = []
    const modeChanges: boolean[] = []
    render(
      <AskPanel
        provider={provider()}
        micRecognizer={fake.recognizer}
        micStorage={storage}
        onAskStart={(text, origin) => askStarts.push([text, origin])}
        onVoiceModeChange={(active) => modeChanges.push(active)}
      />,
    )
    await click(container.querySelector('button[aria-label="Speak a question"]') as HTMLButtonElement)
    await fake.emit.final({ transcript: 'rent in Hilo under two thousand', confidence: 0.95 })
    expect(askStarts).toEqual([['rent in Hilo under two thousand', 'voice']])
    expect(modeChanges).toContain(true)
  })

  it('a typed submit creates a typed ask', async () => {
    const askStarts: Array<[string, AnswerRequestOrigin]> = []
    const modeChanges: boolean[] = []
    render(
      <AskPanel
        provider={provider()}
        micStorage={fakeStorage()}
        onAskStart={(text, origin) => askStarts.push([text, origin])}
        onVoiceModeChange={(active) => modeChanges.push(active)}
      />,
    )
    const input = container.querySelector('#ask-input') as HTMLInputElement
    typeInto(input, 'rent in Hilo under two thousand')
    const form = container.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(askStarts).toEqual([['rent in Hilo under two thousand', 'typed']])
    expect(modeChanges).toContain(false)
  })

  it('an example chip creates a typed ask', async () => {
    const askStarts: Array<[string, AnswerRequestOrigin]> = []
    render(
      <AskPanel
        provider={provider()}
        micStorage={fakeStorage()}
        onAskStart={(text, origin) => askStarts.push([text, origin])}
      />,
    )
    await click(button('Compare rent in Honolulu and Hilo'))
    expect(askStarts).toEqual([['Compare rent in Honolulu and Hilo', 'typed']])
  })

  it('a transcript that lands in clarification creates no ask and stamps nothing', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    grantMicConsent(storage)
    const askStarts: Array<[string, AnswerRequestOrigin]> = []
    render(
      <AskPanel
        provider={provider()}
        micRecognizer={fake.recognizer}
        micStorage={storage}
        onAskStart={(text, origin) => askStarts.push([text, origin])}
      />,
    )
    await click(container.querySelector('button[aria-label="Speak a question"]') as HTMLButtonElement)
    await fake.emit.final({ transcript: '', confidence: 0 })
    expect(askStarts).toEqual([])
  })
})
