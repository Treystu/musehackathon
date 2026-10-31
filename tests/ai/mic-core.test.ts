import { describe, expect, it } from 'vitest'
import {
  assessTranscript,
  checkSpokenNumbers,
  grantMicConsent,
  hasMicConsent,
  revokeMicConsent,
  spokenNumberFigures,
  TRANSCRIPT_CONFIDENCE_THRESHOLD,
  type MicStorage,
} from '../../src/core/ai/mic'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { createValidator } from '../../src/core/ai/validator'

function fakeStorage(): MicStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('mic consent (first use)', () => {
  it('starts ungranted, grants explicitly, and revokes', () => {
    const storage = fakeStorage()
    expect(hasMicConsent(storage)).toBe(false)
    grantMicConsent(storage)
    expect(hasMicConsent(storage)).toBe(true)
    revokeMicConsent(storage)
    expect(hasMicConsent(storage)).toBe(false)
  })

  it('persists across a fresh read of the same storage', () => {
    const storage = fakeStorage()
    grantMicConsent(storage)
    // A later session resolves consent from storage alone.
    expect(hasMicConsent(storage)).toBe(true)
    revokeMicConsent(storage)
  })

  it('falls back to memory when no storage is available', () => {
    revokeMicConsent()
    expect(hasMicConsent()).toBe(false)
    grantMicConsent()
    expect(hasMicConsent()).toBe(true)
    revokeMicConsent()
    expect(hasMicConsent()).toBe(false)
  })
})

describe('transcript assessment', () => {
  it('accepts a clear transcript at or above the threshold', () => {
    expect(assessTranscript({ transcript: 'rent in Hilo', confidence: 0.95 }).kind).toBe('accept')
    expect(
      assessTranscript({ transcript: 'rent in Hilo', confidence: TRANSCRIPT_CONFIDENCE_THRESHOLD }).kind,
    ).toBe('accept')
  })

  it('low confidence goes to clarification, never substitution', () => {
    const a = assessTranscript({ transcript: 'rent in hilo under too thousand', confidence: 0.4 })
    expect(a.kind).toBe('clarify')
    if (a.kind === 'clarify') expect(a.reason).toBe('low_confidence')
    // The heard words are preserved verbatim for the user to check.
    expect(a.transcript).toBe('rent in hilo under too thousand')
  })

  it('empty or whitespace speech goes to clarification as empty', () => {
    for (const transcript of ['', '   ']) {
      const a = assessTranscript({ transcript, confidence: 0.99 })
      expect(a.kind).toBe('clarify')
      if (a.kind === 'clarify') expect(a.reason).toBe('empty')
    }
  })

  it('a missing or non-finite confidence is treated as low confidence', () => {
    const nan = assessTranscript({ transcript: 'rent', confidence: Number.NaN })
    expect(nan.kind).toBe('clarify')
  })
})

const sweepIntent: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2000 }],
  clarificationNeeded: false,
}

describe('spoken-number validation', () => {
  const validator = createValidator()

  it('figures come from filter values plus stated ZIP geographies only', () => {
    const figures = spokenNumberFigures({
      ...sweepIntent,
      geographies: ['96778', 'Hilo'],
    })
    expect(figures).toEqual([
      { key: 'median_gross_rent', value: 2000 },
      { key: 'geography_zip', value: 96778 },
    ])
  })

  it('passes when the spoken numbers match the understood request', () => {
    const verdict = checkSpokenNumbers(
      'Show me places in Hilo with rent under two thousand dollars',
      sweepIntent,
      validator,
    )
    expect(verdict.pass).toBe(true)
  })

  it('passes for digit numerals and a stated ZIP', () => {
    const intent: ValidatedIntent = { ...sweepIntent, geographies: ['96778'] }
    const verdict = checkSpokenNumbers('rent under 2000 in 96778', intent, validator)
    expect(verdict.pass).toBe(true)
  })

  it('passes for a spoken percent against a percent filter', () => {
    const intent: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['Hilo'],
      metricKeys: ['median_rent_burden_pct'],
      filters: [{ metricKey: 'median_rent_burden_pct', op: 'gt', value: 30 }],
      clarificationNeeded: false,
    }
    const verdict = checkSpokenNumbers('burden over thirty percent', intent, validator)
    expect(verdict.pass).toBe(true)
  })

  it('fails closed when a spoken number was dropped or altered by the parse', () => {
    const verdict = checkSpokenNumbers(
      'rent under five thousand',
      sweepIntent, // understood as under 2000
      validator,
    )
    expect(verdict.pass).toBe(false)
    if (!verdict.pass) expect(verdict.failure).toBe('invented_numeral')
  })

  it('fails closed for a ZIP-shaped number that was not a stated geography', () => {
    const verdict = checkSpokenNumbers('rent under 2000 in 96778', sweepIntent, validator)
    expect(verdict.pass).toBe(false)
  })

  it('a transcript with no numerals passes trivially', () => {
    const verdict = checkSpokenNumbers('compare Hilo and Honolulu rent', sweepIntent, validator)
    expect(verdict.pass).toBe(true)
  })
})
