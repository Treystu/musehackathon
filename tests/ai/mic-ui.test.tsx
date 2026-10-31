// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MicStorage } from '../../src/core/ai/mic'
import {
  createStubProvider,
  type MuseProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  AskPanel,
  EMPTY_TRANSCRIPT_NOTE,
  LOW_CONFIDENCE_TRANSCRIPT_NOTE,
  SPOKEN_NUMBER_MISMATCH_NOTE,
} from '../../src/ui/ai/AskPanel'
import type { MicRecorder } from '../../src/ui/ai/MicInput'

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

function fakeRecorder() {
  const calls = { start: 0, stop: 0 }
  const recorder: MicRecorder = {
    async start() {
      calls.start++
    },
    async stop() {
      calls.stop++
      return { audio: new ArrayBuffer(8), mimeType: 'audio/webm' }
    },
  }
  return { recorder, calls }
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
  if (!found) throw new Error(`button not found: ${text}`)
  return found as HTMLButtonElement
}

function maybeButton(text: string): HTMLButtonElement | null {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
  return (found as HTMLButtonElement | undefined) ?? null
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function statusTexts(): string[] {
  return [...container.querySelectorAll('p[role="status"]')].map(
    (el) => el.textContent ?? '',
  )
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
  clarificationNeeded: false,
}

function render(node: ReactNode) {
  act(() => root.render(node))
}

describe('mic consent gate (Item 12)', () => {
  it('the recorder cannot start before first-use consent; declining keeps it off', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecorder={recorder}
        micStorage={storage}
      />,
    )

    await click(button('Speak a question'))
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(calls.start).toBe(0)

    await click(button('Not now'))
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(calls.start).toBe(0)

    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    expect(calls.start).toBe(0) // consent alone never records

    await click(button('Speak a question'))
    expect(calls.start).toBe(1)
    await click(button('Stop recording'))
    expect(calls.stop).toBe(1)
  })

  it('consent persists: a remounted panel records without asking again', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(calls.start).toBe(1)
  })

  it('withdrawing consent returns the surface to the first-use gate', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    await click(button('Forget voice consent'))
    await click(button('Speak a question'))
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(calls.start).toBe(0)
  })
})

describe('mic transcript flow', () => {
  function spokenProvider(transcript: string, confidence: number, intentCalls: { n: number; lastText?: string }): MuseProvider {
    return createStubProvider({
      async transcribe() {
        return { transcript, confidence }
      },
      async intent(req) {
        intentCalls.n++
        intentCalls.lastText = req.queryText
        return { intent: sweepIntent }
      },
    })
  }

  async function speak() {
    await click(button('Speak a question'))
    if (maybeButton('Allow microphone')) await click(button('Allow microphone'))
    await click(button('Speak a question'))
    await click(button('Stop recording'))
  }

  it('accepted speech lands in the editable text and chips, and offers Run', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const { recorder } = fakeRecorder()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
        onExecute={() => {}}
      />,
    )
    await speak()
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('rent in Hilo under two thousand')
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('rent in Hilo under two thousand')
    // The understood request is shown as editable chips before anything runs.
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(maybeButton('Run this request')).not.toBeNull()
  })

  it('low-confidence speech goes to clarification: words stay editable, nothing runs', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const { recorder } = fakeRecorder()
    render(
      <AskPanel
        provider={spokenProvider('rent in hilo under too thousand', 0.4, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
        onExecute={() => {}}
      />,
    )
    await speak()
    expect(intentCalls.n).toBe(0)
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('rent in hilo under too thousand')
    expect(statusTexts().join(' ')).toContain(LOW_CONFIDENCE_TRANSCRIPT_NOTE)
    expect(maybeButton('Run this request')).toBeNull()
  })

  it('empty speech asks again and runs nothing', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const { recorder } = fakeRecorder()
    render(
      <AskPanel
        provider={spokenProvider('', 0.9, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
      />,
    )
    await speak()
    expect(intentCalls.n).toBe(0)
    expect(statusTexts().join(' ')).toContain(EMPTY_TRANSCRIPT_NOTE)
  })

  it('a spoken number the parse altered fails closed: no chips, no Run, words kept for editing', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const { recorder } = fakeRecorder()
    render(
      <AskPanel
        // The user said five thousand; the parse understood 2000.
        provider={spokenProvider('rent in Hilo under five thousand', 0.97, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
        onExecute={() => {}}
      />,
    )
    await speak()
    expect(intentCalls.n).toBe(1)
    expect(statusTexts().join(' ')).toContain(SPOKEN_NUMBER_MISMATCH_NOTE)
    expect(container.querySelector('[aria-label="What was understood"]')).toBeNull()
    expect(maybeButton('Run this request')).toBeNull()
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('rent in Hilo under five thousand')
  })

  it('a transcription failure returns to idle with the manual-parity note', async () => {
    const { recorder } = fakeRecorder()
    const provider = createStubProvider({
      async transcribe() {
        throw Object.assign(new Error('down'), { code: 'provider_down' })
      },
    })
    render(<AskPanel provider={provider} micRecorder={recorder} micStorage={fakeStorage()} />)
    await speak()
    expect(statusTexts().join(' ')).toContain('Speech could not be turned into text')
    expect(maybeButton('Speak a question')).not.toBeNull()
  })
})

describe('mic availability and the keyboard path (Q2)', () => {
  it('no recorder: the surface says so plainly, renders no Speak button, and typing still works', async () => {
    const intentCalls = { n: 0 }
    const provider = createStubProvider({
      async intent() {
        intentCalls.n++
        return { intent: sweepIntent }
      },
    })
    render(<AskPanel provider={provider} micRecorder={null} micStorage={fakeStorage()} />)
    expect(container.textContent).toContain('Voice input is not available in this browser')
    expect(container.textContent).toContain('audio is not stored')
    expect(maybeButton('Speak a question')).toBeNull()

    const input = container.querySelector('#ask-input') as HTMLInputElement
    typeInto(input, 'rent in Hilo under two thousand')
    const form = input.closest('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(intentCalls.n).toBe(1)
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
  })
})
