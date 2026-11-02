/**
 * Speech driver (conversational stack C10, branch b).
 *
 * The Meta Model API roster (re-verified 2026-11-02) has no
 * text-to-speech model, so voice-out is the device's own
 * speechSynthesis. This module is the small, React-free wrapper the
 * voice UI drives: it owns the utterance queue, the voice-mode
 * activation flag, and a sticky session mute. It is unit-testable
 * with a fake synthesis object; the browser object is resolved only
 * when the caller supplies none.
 *
 * Copy boundary: this driver speaks text it is given; it makes no
 * claim about the voice. Where the product states the distinction,
 * the sentence is METHODOLOGY_VOICE_SENTENCE in spoken-answer.ts --
 * the intelligence is Muse; the voice is the device's.
 */

export interface SpeechUtteranceLike {
  text: string
  onend?: (() => void) | null
  onerror?: (() => void) | null
}

export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void
  cancel(): void
  speaking?: boolean
  pending?: boolean
}

export type UtteranceFactory = (text: string) => SpeechUtteranceLike

export interface SpeechDriver {
  /**
   * Queue sentences for speech, in order, replacing anything still
   * queued. Returns true when at least one sentence was queued.
   * Queues nothing when voice mode is inactive, when the session is
   * muted, when no synthesis is available, or for an empty list.
   */
  speak(sentences: readonly string[]): boolean
  /** Stop immediately: cancel the device queue and forget our own. */
  stop(): void
  isSpeaking(): boolean
  /** Voice-mode activation: speech is automatic only while active. */
  setVoiceModeActive(active: boolean): void
  isVoiceModeActive(): boolean
  /**
   * Sticky session mute: muting stops current speech and suppresses
   * every later speak() until unmute() is called explicitly. It is
   * session state on the driver instance, never persisted, and never
   * cleared as a side effect of a new answer arriving.
   */
  mute(): void
  unmute(): void
  isMuted(): boolean
  /** True when a synthesis object exists on this device at all. */
  isAvailable(): boolean
}

function browserSynthesis(): SpeechSynthesisLike | null {
  try {
    const candidate = (
      globalThis as { speechSynthesis?: unknown }
    ).speechSynthesis
    if (
      candidate &&
      typeof (candidate as SpeechSynthesisLike).speak === 'function' &&
      typeof (candidate as SpeechSynthesisLike).cancel === 'function'
    ) {
      return candidate as SpeechSynthesisLike
    }
  } catch {
    // Access can throw in restricted contexts; voice-out is absent.
  }
  return null
}

function browserUtteranceFactory(): UtteranceFactory | null {
  try {
    const Ctor = (
      globalThis as {
        SpeechSynthesisUtterance?: new (text: string) => SpeechUtteranceLike
      }
    ).SpeechSynthesisUtterance
    if (typeof Ctor === 'function') return (text) => new Ctor(text)
  } catch {
    // No utterance constructor: voice-out is absent.
  }
  return null
}

export function createSpeechDriver(options?: {
  /** undefined = resolve the browser synthesis; null = no synthesis. */
  synthesis?: SpeechSynthesisLike | null
  createUtterance?: UtteranceFactory
  /** Voice mode starts inactive unless the caller says otherwise. */
  voiceModeActive?: boolean
}): SpeechDriver {
  const synthesis =
    options?.synthesis === undefined
      ? browserSynthesis()
      : options.synthesis
  const factory =
    options?.createUtterance ??
    browserUtteranceFactory() ??
    ((text: string): SpeechUtteranceLike => ({ text }))

  let voiceModeActive = options?.voiceModeActive ?? false
  let muted = false
  // Utterances handed to the device that have not yet ended. The
  // device queue is FIFO, so speak order is queue order; this count
  // is what isSpeaking reports when the device object does not.
  let outstanding = 0

  function stop(): void {
    outstanding = 0
    try {
      synthesis?.cancel()
    } catch {
      // A failing cancel must not break the stop control itself.
    }
  }

  return {
    speak(sentences) {
      if (!synthesis || !voiceModeActive || muted) return false
      const queue = sentences
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (queue.length === 0) return false
      // A new spoken answer replaces the old one: a refined answer
      // must not queue behind the provisional it supersedes.
      stop()
      for (const text of queue) {
        const utterance = factory(text)
        outstanding++
        const settle = () => {
          if (outstanding > 0) outstanding--
        }
        utterance.onend = settle
        utterance.onerror = settle
        synthesis.speak(utterance)
      }
      return true
    },
    stop,
    isSpeaking() {
      if (!synthesis) return false
      if (typeof synthesis.speaking === 'boolean') {
        return synthesis.speaking || outstanding > 0
      }
      return outstanding > 0
    },
    setVoiceModeActive(active) {
      voiceModeActive = active
      // Leaving voice mode silences it: no speech outlives the mode
      // that authorised it.
      if (!active) stop()
    },
    isVoiceModeActive() {
      return voiceModeActive
    },
    mute() {
      muted = true
      stop()
    },
    unmute() {
      muted = false
    },
    isMuted() {
      return muted
    },
    isAvailable() {
      return synthesis !== null
    },
  }
}
