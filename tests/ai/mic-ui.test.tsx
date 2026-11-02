// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  type TranscribeResult,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import {
  AskPanel,
  EMPTY_TRANSCRIPT_NOTE,
  SPOKEN_NUMBER_MISMATCH_NOTE,
} from '../../src/ui/ai/AskPanel'
import type {
  MicRecognitionHandlers,
  MicRecognizer,
  MicRecorder,
} from '../../src/ui/ai/MicInput'

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

/**
 * Fake recognizer: captures the session handlers so a test drives the
 * utterance itself — interim words, then the final transcript at the
 * end of the utterance — exactly the events the browser recognizer
 * produces. No stop/submit control exists for the test to click,
 * because none exists in the flow.
 */
function fakeRecognizer(options: { denyStart?: boolean } = {}) {
  const calls = { start: 0, abort: 0 }
  let handlers: MicRecognitionHandlers | null = null
  const recognizer: MicRecognizer = {
    async start(h) {
      calls.start++
      if (options.denyStart) throw new Error('permission denied')
      handlers = h
    },
    abort() {
      calls.abort++
    },
  }
  const emit = {
    async interim(transcript: string) {
      await act(async () => handlers?.onInterim(transcript))
    },
    async final(result: TranscribeResult) {
      await act(async () => handlers?.onFinal(result))
    },
    async error() {
      await act(async () => handlers?.onError())
    },
  }
  return { recognizer, calls, emit }
}

function fakeRecorder(endPromise: Promise<void>) {
  const calls = { start: 0, stop: 0 }
  const recorder: MicRecorder = {
    async start() {
      calls.start++
    },
    async stop() {
      calls.stop++
      return { audio: new ArrayBuffer(8), mimeType: 'audio/webm' }
    },
    waitForEndOfUtterance: () => endPromise,
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

/** The one voice icon: an icon-only button, found by its accessible name. */
function voiceIcon(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Speak a question"]')
}

function voiceSection(): HTMLElement {
  const found = container.querySelector('section[aria-label="Voice input"]')
  if (!found) throw new Error('voice section not found')
  return found as HTMLElement
}

/** Accessible names of every button inside the voice section. */
function voiceButtonNames(): string[] {
  return [...voiceSection().querySelectorAll('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent ?? '',
  )
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickVoiceIcon() {
  const icon = voiceIcon()
  if (!icon) throw new Error('voice icon not found')
  await click(icon)
}

/** Tap the icon, and Allow when the first-use gate is showing. */
async function speakTap() {
  await clickVoiceIcon()
  if (maybeButton('Allow microphone')) await click(button('Allow microphone'))
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

function spokenProvider(
  transcript: string,
  confidence: number,
  intentCalls: { n: number; lastText?: string },
): MuseProvider {
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

describe('mic consent gate (Item 12, kept with reason)', () => {
  it('capture cannot start before first-use consent; declining keeps it off', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecognizer={fake.recognizer}
        micStorage={storage}
      />,
    )

    await clickVoiceIcon()
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(fake.calls.start).toBe(0)

    await click(button('Not now'))
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(fake.calls.start).toBe(0)

    await clickVoiceIcon()
    // Allow chains directly into capture (one continuous consent
    // moment, 2026-11-02): no second icon tap, and capture — the
    // browser permission prompt inside it — starts from Allow itself.
    await click(button('Allow microphone'))
    expect(fake.calls.start).toBe(1)
    expect(voiceIcon()).toBeNull()
  })

  it('consent persists: a remounted panel captures without asking again', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecognizer={fake.recognizer} micStorage={storage} />,
    )
    await clickVoiceIcon()
    await click(button('Allow microphone'))
    expect(fake.calls.start).toBe(1)
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(
      <AskPanel provider={createStubProvider()} micRecognizer={fake.recognizer} micStorage={storage} />,
    )
    await clickVoiceIcon()
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(fake.calls.start).toBe(2)
  })

  it('withdrawing consent returns the surface to the first-use gate', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecognizer={fake.recognizer} micStorage={storage} />,
    )
    await speakTap()
    expect(fake.calls.start).toBe(1)
    // End the utterance so the surface is idle and consent controls show.
    await fake.emit.final({ transcript: '', confidence: 0 })
    await click(button('Forget voice consent'))
    expect(hasMicConsent(storage)).toBe(false)
    await clickVoiceIcon()
    expect(container.textContent).toContain('Voice input uses your microphone')
    expect(fake.calls.start).toBe(1)
  })

  it('stored consent goes straight to capture with no gate', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    grantMicConsent(storage)
    render(
      <AskPanel provider={createStubProvider()} micRecognizer={fake.recognizer} micStorage={storage} />,
    )
    await clickVoiceIcon()
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(fake.calls.start).toBe(1)
    expect(voiceIcon()).toBeNull()
  })

  it('gate "Not now" ends the flow quietly: no capture, no status line', async () => {
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    await clickVoiceIcon()
    await click(button('Not now'))
    expect(fake.calls.start).toBe(0)
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(statusTexts().join(' ')).not.toContain('Speech could not be turned into text')
    expect(voiceIcon()).not.toBeNull()
  })

  it('a browser deny from the Allow path ends with a single honest status line', async () => {
    const fake = fakeRecognizer({ denyStart: true })
    render(
      <AskPanel
        provider={createStubProvider()}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    await clickVoiceIcon()
    await click(button('Allow microphone'))
    const failures = statusTexts().filter((t) =>
      t.includes('Speech could not be turned into text'),
    )
    expect(failures).toHaveLength(1)
    expect(container.textContent).not.toContain('Voice input uses your microphone')
    expect(voiceIcon()).not.toBeNull()
  })

  it('"Forget voice consent" lives in the audio help panel, not on the mic row, and still withdraws consent', async () => {
    const fake = fakeRecognizer()
    const storage = fakeStorage()
    render(
      <AskPanel provider={createStubProvider()} micRecognizer={fake.recognizer} micStorage={storage} />,
    )
    await speakTap()
    await fake.emit.final({ transcript: '', confidence: 0 })
    const icon = voiceIcon()
    if (!icon) throw new Error('voice icon not found')
    const row = icon.parentElement as HTMLElement
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
    await clickVoiceIcon()
    expect(container.textContent).toContain('Voice input uses your microphone')
  })
})

describe('voice atomic submission (Item 16, owner ruling 2026-11-02)', () => {
  it('interim words stream into the box and never submit; the final transcript submits exactly once with no further click', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const executed: unknown[] = []
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
        onExecute={(intent) => {
          executed.push(intent)
        }}
      />,
    )
    await speakTap()
    const input = container.querySelector('#ask-input') as HTMLInputElement
    // Interim words show in the ask pill as they are heard…
    await fake.emit.interim('rent in')
    expect(input.value).toBe('rent in')
    await fake.emit.interim('rent in Hilo under two')
    expect(input.value).toBe('rent in Hilo under two')
    // …and none of them submits early.
    expect(intentCalls.n).toBe(0)
    expect(executed).toHaveLength(0)
    // End of utterance: the final transcript IS the submission. No
    // click happens between this event and the run.
    await fake.emit.final({ transcript: 'rent in Hilo under two thousand', confidence: 0.95 })
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('rent in Hilo under two thousand')
    expect(input.value).toBe('rent in Hilo under two thousand')
    // The understood request shows as editable chips, and (auto-run,
    // 2026-11-01) it executes through the same path as a typed submit.
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(executed).toHaveLength(1)
    expect(maybeButton('Run this request')).toBeNull()
  })

  it('a repeated terminal event from the recognizer still submits only once', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    await speakTap()
    await fake.emit.final({ transcript: 'rent in Hilo under two thousand', confidence: 0.95 })
    await fake.emit.final({ transcript: 'rent in Hilo under two thousand', confidence: 0.95 })
    expect(intentCalls.n).toBe(1)
  })

  it('no stop, verify, review, or submit affordance renders in the voice path at any phase', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    const forbidden = /stop|verify|confirm|submit|review|use these words|looks right/i
    // Idle: the section carries the one voice icon and the help tip only.
    expect(voiceButtonNames().filter((n) => forbidden.test(n))).toEqual([])
    await speakTap()
    // Listening: no button in the voice path can end or submit the
    // utterance — the icon itself is gone while listening.
    expect(voiceIcon()).toBeNull()
    expect(voiceButtonNames().filter((n) => forbidden.test(n))).toEqual([])
    expect(statusTexts().join(' ')).toContain('Listening')
    await fake.emit.final({ transcript: 'rent in Hilo under two thousand', confidence: 0.95 })
    // After submission the voice path is back to the one icon.
    expect(voiceButtonNames().filter((n) => forbidden.test(n))).toEqual([])
    expect(voiceIcon()).not.toBeNull()
    expect(intentCalls.n).toBe(1)
  })

  it('the shipped source carries no stop/verify/review affordance in the voice path', () => {
    // A source pin in the test_gates style: the affordances the owner
    // removed must not creep back as a renamed button or a reworded
    // review instruction. The consent sheet's Allow / Not now are a
    // load-bearing disclosure, not a submission affordance, and are
    // not matched here.
    const mic = readFileSync(join(process.cwd(), 'src/ui/ai/MicInput.tsx'), 'utf8')
    const ask = readFileSync(join(process.cwd(), 'src/ui/ai/AskPanel.tsx'), 'utf8')
    expect(mic).not.toContain('Stop recording')
    expect(mic).not.toMatch(/>\s*Verify</)
    expect(mic).not.toMatch(/>\s*Confirm</)
    expect(ask).not.toContain('then choose Ask')
    expect(ask).not.toContain('LOW_CONFIDENCE')
  })

  it('a low-confidence final transcript submits like any other: correctable after, never reviewed before', async () => {
    // A numeral-free transcript, so the kept spoken-number guard has
    // nothing to fail closed on: this pin isolates the confidence
    // gate's removal.
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const executed: unknown[] = []
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('compare rent in Hilo and Honolulu', 0.4, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
        onExecute={(intent) => {
          executed.push(intent)
        }}
      />,
    )
    await speakTap()
    await fake.emit.final({ transcript: 'compare rent in Hilo and Honolulu', confidence: 0.4 })
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('compare rent in Hilo and Honolulu')
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('compare rent in Hilo and Honolulu')
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
    expect(executed).toHaveLength(1)
    expect(statusTexts().join(' ')).not.toContain('choose Ask')
  })

  it('empty final speech submits nothing and lands in the quiet state', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('', 0.9, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    await speakTap()
    await fake.emit.final({ transcript: '', confidence: 0 })
    expect(intentCalls.n).toBe(0)
    expect(statusTexts().join(' ')).toContain(EMPTY_TRANSCRIPT_NOTE)
    // No stranded review screen: the surface is idle, the icon is back.
    expect(container.querySelector('[aria-label="What was understood"]')).toBeNull()
    expect(voiceIcon()).not.toBeNull()
  })

  it('a recognition error ends in the honest quiet state, never a dead end', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo', 0.95, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    await speakTap()
    await fake.emit.error()
    expect(intentCalls.n).toBe(0)
    expect(statusTexts().join(' ')).toContain('Speech could not be turned into text')
    expect(container.querySelector('[aria-label="What was understood"]')).toBeNull()
    expect(voiceIcon()).not.toBeNull()
  })

  it('a spoken number the parse altered still fails closed: no chips, no run, words kept for correction', async () => {
    // Kept with reason: this is the load-bearing numeral guard, not a
    // verify click. The transcript submitted atomically; the request
    // simply never runs on a number the reader did not say, and the
    // words stand in the box for the existing edit/re-ask correction.
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        // The user said five thousand; the parse understood 2000.
        provider={spokenProvider('rent in Hilo under five thousand', 0.97, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
        onExecute={() => {}}
      />,
    )
    await speakTap()
    await fake.emit.final({ transcript: 'rent in Hilo under five thousand', confidence: 0.97 })
    expect(intentCalls.n).toBe(1)
    expect(statusTexts().join(' ')).toContain(SPOKEN_NUMBER_MISMATCH_NOTE)
    expect(container.querySelector('[aria-label="What was understood"]')).toBeNull()
    expect(maybeButton('Run this request')).toBeNull()
    const input = container.querySelector('#ask-input') as HTMLInputElement
    expect(input.value).toBe('rent in Hilo under five thousand')
  })

  it('the recorder fallback is atomic too: its end-of-utterance signal submits with no stop click', async () => {
    let endUtterance: () => void = () => {}
    const endPromise = new Promise<void>((resolve) => {
      endUtterance = resolve
    })
    const { recorder, calls } = fakeRecorder(endPromise)
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    render(
      <AskPanel
        provider={spokenProvider('rent in Hilo under two thousand', 0.95, intentCalls)}
        micRecorder={recorder}
        micStorage={fakeStorage()}
      />,
    )
    await speakTap()
    expect(calls.start).toBe(1)
    expect(voiceButtonNames().join(' ')).not.toMatch(/stop/i)
    // The utterance ends; the recorder path transcribes and submits.
    await act(async () => endUtterance())
    expect(calls.stop).toBe(1)
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('rent in Hilo under two thousand')
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
  })

  it('a transcription failure on the recorder path returns to idle with the manual-parity note', async () => {
    let endUtterance: () => void = () => {}
    const endPromise = new Promise<void>((resolve) => {
      endUtterance = resolve
    })
    const { recorder } = fakeRecorder(endPromise)
    const provider = createStubProvider({
      async transcribe() {
        throw Object.assign(new Error('down'), { code: 'provider_down' })
      },
    })
    render(<AskPanel provider={provider} micRecorder={recorder} micStorage={fakeStorage()} />)
    await speakTap()
    await act(async () => endUtterance())
    expect(statusTexts().join(' ')).toContain('Speech could not be turned into text')
    expect(voiceIcon()).not.toBeNull()
  })
})

describe('mic availability and the keyboard path (Q2)', () => {
  it('no recognizer: the surface says so plainly, renders no voice icon, and typing still works', async () => {
    const intentCalls = { n: 0 }
    const provider = createStubProvider({
      async intent() {
        intentCalls.n++
        return { intent: sweepIntent }
      },
    })
    render(<AskPanel provider={provider} micRecognizer={null} micStorage={fakeStorage()} />)
    expect(container.textContent).toContain('Voice input is not available in this browser')
    expect(container.textContent).toContain('audio is not stored')
    expect(voiceIcon()).toBeNull()

    const input = container.querySelector('#ask-input') as HTMLInputElement
    typeInto(input, 'rent in Hilo under two thousand')
    const form = input.closest('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(intentCalls.n).toBe(1)
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
  })

  it('the typed Ask flow is unchanged beside a live voice path', async () => {
    const intentCalls = { n: 0, lastText: undefined as string | undefined }
    const fake = fakeRecognizer()
    render(
      <AskPanel
        provider={spokenProvider('unused', 0.95, intentCalls)}
        micRecognizer={fake.recognizer}
        micStorage={fakeStorage()}
      />,
    )
    const input = container.querySelector('#ask-input') as HTMLInputElement
    typeInto(input, 'rent in Hilo under two thousand')
    const form = input.closest('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(intentCalls.n).toBe(1)
    expect(intentCalls.lastText).toBe('rent in Hilo under two thousand')
    expect(fake.calls.start).toBe(0)
    expect(container.querySelector('[aria-label="What was understood"]')).not.toBeNull()
  })
})
