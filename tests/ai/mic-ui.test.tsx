// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  grantMicConsent,
  hasMicConsent,
  type MicStorage,
} from '../../src/core/ai/mic'
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
    // Allow chains directly into the recorder (one continuous
    // consent moment, 2026-11-02): no second Speak click, and the
    // recorder — the browser permission prompt inside it — starts
    // from the Allow click itself.
    await click(button('Allow microphone'))
    expect(calls.start).toBe(1)
    expect(maybeButton('Stop recording')).not.toBeNull()
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
    // Allow started the first recording in the same flow.
    expect(calls.start).toBe(1)
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
    expect(calls.start).toBe(2)
  })

  it('withdrawing consent returns the surface to the first-use gate', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    // Allow started recording in the same flow; stop it, then forget.
    expect(calls.start).toBe(1)
    await click(button('Stop recording'))
    await click(button('Forget voice consent'))
    expect(hasMicConsent(storage)).toBe(false)
    await click(button('Speak a question'))
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(calls.start).toBe(1)
  })
})

describe('mic consent flow: one continuous moment (2026-11-02)', () => {
  it('Allow chains directly to the recorder without a second mic-button activation', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    // First use only: the gate opens and the recorder has not started.
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(calls.start).toBe(0)
    await click(button('Allow microphone'))
    // The Allow click itself started the recorder (the browser
    // permission prompt lives inside it): recording is in progress,
    // the Speak button is gone, and no second activation happened.
    expect(calls.start).toBe(1)
    expect(maybeButton('Speak a question')).toBeNull()
    expect(maybeButton('Stop recording')).not.toBeNull()
    // And the gate does not re-ask on the next use.
    await click(button('Stop recording'))
    await click(button('Speak a question'))
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(calls.start).toBe(2)
  })

  it('stored consent goes straight to recording with no gate', async () => {
    const { recorder, calls } = fakeRecorder()
    const storage = fakeStorage()
    grantMicConsent(storage)
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(calls.start).toBe(1)
    expect(maybeButton('Stop recording')).not.toBeNull()
  })

  it('gate "Not now" ends the flow quietly: no recorder, no status line', async () => {
    const { recorder, calls } = fakeRecorder()
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecorder={recorder}
        micStorage={fakeStorage()}
      />,
    )
    await click(button('Speak a question'))
    await click(button('Not now'))
    expect(calls.start).toBe(0)
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(statusTexts().join(' ')).not.toContain('Speech could not be turned into text')
    expect(maybeButton('Speak a question')).not.toBeNull()
  })

  it('a browser deny from the Allow path ends with a single honest status line', async () => {
    const denyingRecorder: MicRecorder = {
      async start() {
        throw new Error('permission denied')
      },
      async stop() {
        return { audio: new ArrayBuffer(8), mimeType: 'audio/webm' }
      },
    }
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecorder={denyingRecorder}
        micStorage={fakeStorage()}
      />,
    )
    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    const failures = statusTexts().filter((t) =>
      t.includes('Speech could not be turned into text'),
    )
    expect(failures).toHaveLength(1)
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(maybeButton('Speak a question')).not.toBeNull()
  })

  it('"Forget voice consent" lives in the audio help panel, not on the mic row, and still withdraws consent', async () => {
    const { recorder } = fakeRecorder()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecorder={recorder} micStorage={storage} />,
    )
    await click(button('Speak a question'))
    await click(button('Allow microphone'))
    await click(button('Stop recording'))
    const speak = button('Speak a question')
    const row = speak.parentElement as HTMLElement
    // Not a direct control of the primary row…
    expect(
      [...row.children].some((el) => el.textContent === 'Forget voice consent'),
    ).toBe(false)
    // …it sits inside the audio disclosure's help panel, beside the
    // disclosure text whose consent it withdraws.
    const forget = button('Forget voice consent')
    const panel = forget.parentElement as HTMLElement
    expect(panel.querySelector('#ask-audio-note')).not.toBeNull()
    expect(panel.textContent).toContain('audio is not stored')
    // Behaviour unchanged: consent is actually forgotten.
    await click(forget)
    expect(hasMicConsent(storage)).toBe(false)
    await click(button('Speak a question'))
    expect(container.textContent).toContain('Voice input uses your microphone')
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
    // First use: Allow chains directly into recording (2026-11-02),
    // so there is no second Speak click — Stop is the next control.
    if (maybeButton('Allow microphone')) await click(button('Allow microphone'))
    await click(button('Stop recording'))
  }

  it('accepted speech lands in the editable text and chips, and runs like typed text', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const executed: unknown[] = []
    const { recorder } = fakeRecorder()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
        onExecute={(intent) => {
          executed.push(intent)
        }}
      />,
    )
    await speak()
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('rent in Hilo under two thousand')
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('rent in Hilo under two thousand')
    // The understood request shows as editable chips, and (auto-run,
    // 2026-11-01) it executes through the same path as a typed submit.
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(executed).toHaveLength(1)
    expect(maybeButton('Run this request')).toBeNull()
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
