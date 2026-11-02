import { describe, expect, it } from 'vitest'
import {
  assessTranscript,
  checkSpokenNumbers,
  grantMicConsent,
  hasMicConsent,
  revokeMicConsent,
  spokenNumberFigures,
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

describe('transcript assessment (atomic submission, 2026-11-02)', () => {
  it('accepts a clear final transcript', () => {
    expect(assessTranscript({ transcript: 'rent in Hilo', confidence: 0.95 }).kind).toBe('accept')
  })

  it('accepts a low-confidence final transcript: no review gate stands before submission', () => {
    // Owner ruling, 2026-11-02: end of utterance submits at any
    // confidence; the words are correctable after, in the box. The
    // pre-cure behaviour (clarify + "then choose Ask") was the verify
    // click this pin exists to keep removed.
    const a = assessTranscript({ transcript: 'rent in hilo under too thousand', confidence: 0.4 })
    expect(a.kind).toBe('accept')
    expect(a.transcript).toBe('rent in hilo under too thousand')
  })

  it('accepts a final transcript whose confidence is missing or non-finite', () => {
    expect(assessTranscript({ transcript: 'rent', confidence: Number.NaN }).kind).toBe('accept')
  })

  it('empty or whitespace speech goes to clarification as empty, and nothing else does', () => {
    for (const transcript of ['', '   ']) {
      const a = assessTranscript({ transcript, confidence: 0.99 })
      expect(a.kind).toBe('clarify')
      if (a.kind === 'clarify') expect(a.reason).toBe('empty')
    }
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
