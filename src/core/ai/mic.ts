/**
 * Mic core (Item 12): first-use consent state, transcript assessment,
 * and spoken-number validation. Pure logic only — recording devices and
 * network calls live in the UI / provider layers, so every rule here is
 * hermetically testable.
 *
 * Consent mirrors the Meta-key storage pattern (meta-key.ts): the flag
 * lives only in the browser (localStorage, with an in-memory fallback
 * where localStorage is unavailable). It records only that consent was
 * granted — never audio, never a transcript (Q1 counts-only spirit).
 */
import type { TranscribeResult, ValidatedIntent } from './provider'
import type { FigureForValidation, Validator, ValidatorVerdict } from './validator'

/** localStorage key for the visitor's mic consent flag. */
export const MIC_CONSENT_STORAGE_KEY = 'civicscope.micConsent.v1'

/** Dispatched on globalThis whenever the stored consent flag changes. */
export const MIC_CONSENT_EVENT = 'civicscope:mic-consent-changed'

/**
 * Below this transcription confidence a transcript is never accepted as
 * a query as-is: it is shown to the user for checking (clarification),
 * because a mis-heard number silently substituted into a request is the
 * mic path's characteristic failure.
 */
export const TRANSCRIPT_CONFIDENCE_THRESHOLD = 0.8

export interface MicStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): MicStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage
    if (
      candidate &&
      typeof (candidate as MicStorage).getItem === 'function' &&
      typeof (candidate as MicStorage).setItem === 'function' &&
      typeof (candidate as MicStorage).removeItem === 'function'
    ) {
      return candidate as MicStorage
    }
  } catch {
    // Access itself can throw (e.g. blocked storage); fall back to memory.
  }
  return null
}

/** In-memory fallback used when localStorage is unavailable (e.g. node). */
let memoryConsent = false

function resolveStorage(storage?: MicStorage): MicStorage | null {
  return storage ?? browserStorage()
}

function emitConsentChanged(granted: boolean): void {
  try {
    const g = globalThis as {
      dispatchEvent?: unknown
      CustomEvent?: new (type: string, init?: { detail?: unknown }) => unknown
      Event?: new (type: string) => unknown
    }
    if (typeof g.dispatchEvent !== 'function') return
    let event: unknown
    if (typeof g.CustomEvent === 'function') {
      event = new g.CustomEvent(MIC_CONSENT_EVENT, { detail: { granted } })
    } else if (typeof g.Event === 'function') {
      event = new g.Event(MIC_CONSENT_EVENT)
    } else {
      event = { type: MIC_CONSENT_EVENT, detail: { granted } }
    }
    ;(g.dispatchEvent as (e: unknown) => boolean).call(globalThis, event)
  } catch {
    // Event delivery must never break consent storage.
  }
}

/** True only when consent was explicitly granted and not revoked. */
export function hasMicConsent(storage?: MicStorage): boolean {
  const store = resolveStorage(storage)
  if (store) {
    try {
      if (store.getItem(MIC_CONSENT_STORAGE_KEY) === 'granted') return true
      if (store.getItem(MIC_CONSENT_STORAGE_KEY) !== null) return false
    } catch {
      // Blocked storage: fall through to the in-memory copy.
    }
  }
  return memoryConsent
}

/** Record first-use consent. The microphone must not activate before this. */
export function grantMicConsent(storage?: MicStorage): void {
  memoryConsent = true
  const store = resolveStorage(storage)
  if (store) {
    try {
      store.setItem(MIC_CONSENT_STORAGE_KEY, 'granted')
    } catch {
      // Quota/blocked storage: the in-memory copy above still applies.
    }
  }
  emitConsentChanged(true)
}

/** Withdraw consent; the next mic use asks again from the start. */
export function revokeMicConsent(storage?: MicStorage): void {
  memoryConsent = false
  const store = resolveStorage(storage)
  if (store) {
    try {
      store.removeItem(MIC_CONSENT_STORAGE_KEY)
    } catch {
      // Already cleared from memory; nothing else to do.
    }
  }
  emitConsentChanged(false)
}

/* ------------------------------------------------------------------ */
/* Transcript assessment                                               */
/* ------------------------------------------------------------------ */

export type TranscriptAssessment =
  | { kind: 'accept'; transcript: string }
  | { kind: 'clarify'; transcript: string; reason: 'empty' | 'low_confidence' }

/**
 * Decide what a transcription result may become. An accepted transcript
 * still only ever lands in the editable query text / chips — nothing
 * executes from speech without the user seeing and confirming it. A
 * low-confidence or empty transcript goes to clarification instead of
 * being silently substituted for a query.
 */
export function assessTranscript(result: TranscribeResult): TranscriptAssessment {
  const transcript = typeof result?.transcript === 'string' ? result.transcript : ''
  if (transcript.trim() === '') {
    return { kind: 'clarify', transcript, reason: 'empty' }
  }
  const confidence = result?.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < TRANSCRIPT_CONFIDENCE_THRESHOLD
  ) {
    return { kind: 'clarify', transcript, reason: 'low_confidence' }
  }
  return { kind: 'accept', transcript }
}

/* ------------------------------------------------------------------ */
/* Spoken-number validation                                            */
/* ------------------------------------------------------------------ */

/**
 * Figures a spoken numeral is allowed to match: the understood request's
 * filter values, plus any 5-digit ZIP geography stated as a number.
 * Nothing else is computed or invented here.
 */
export function spokenNumberFigures(intent: ValidatedIntent): FigureForValidation[] {
  const figures: FigureForValidation[] = intent.filters.map((f) => ({
    key: f.metricKey,
    value: f.value,
  }))
  for (const g of intent.geographies) {
    if (/^\d{5}$/.test(g.trim())) {
      figures.push({ key: 'geography_zip', value: Number(g.trim()) })
    }
  }
  return figures
}

/**
 * Spoken-number validation through the same fail-closed validator as
 * text prose: every numeral heard in the transcript must match a number
 * in the understood request (a filter value or a stated ZIP). A numeral
 * the intent dropped or altered fails with `invented_numeral`, and the
 * caller forces clarification — the request never runs on a number the
 * user did not say.
 */
export function checkSpokenNumbers(
  transcript: string,
  intent: ValidatedIntent,
  validator: Validator,
): ValidatorVerdict {
  return validator.validate(transcript, spokenNumberFigures(intent))
}
