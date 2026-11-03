import { describe, expect, it } from 'vitest'
import {
  assessTranscript,
  checkSpokenNumbers,
  grantMicConsent,
  hasMicConsent,
  heardNumerals,
  reconcileSpokenIntent,
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
    )
    expect(verdict.pass).toBe(true)
  })

  it('passes for digit numerals and a stated ZIP', () => {
    const intent: ValidatedIntent = { ...sweepIntent, geographies: ['96778'] }
    const verdict = checkSpokenNumbers('rent under 2000 in 96778', intent)
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
    const verdict = checkSpokenNumbers('burden over thirty percent', intent)
    expect(verdict.pass).toBe(true)
  })

  // The numeral verdict itself still fails on a genuine divergence —
  // the protection as a measurement is unchanged. What changed is
  // the disposition on the voice path (reconcile-and-run, below),
  // not the check.
  it('fails when a spoken number was dropped or altered by the parse', () => {
    const verdict = checkSpokenNumbers(
      'rent under five thousand',
      sweepIntent, // understood as under 2000
    )
    expect(verdict.pass).toBe(false)
    if (!verdict.pass) expect(verdict.failure).toBe('invented_numeral')
  })

  it('fails for a ZIP-shaped number that was not a stated geography', () => {
    const verdict = checkSpokenNumbers('rent under 2000 in 96778', sweepIntent)
    expect(verdict.pass).toBe(false)
  })

  it('a transcript with no numerals passes trivially', () => {
    const verdict = checkSpokenNumbers('compare Hilo and Honolulu rent', sweepIntent)
    expect(verdict.pass).toBe(true)
  })

  // The 2026-11-02 23:39 live failure, pinned at the check level:
  // the owner's exact transcript carries no numeral, and the parse
  // it met carried no figures — yet the run dead-ended, because the
  // check then ran the generated-prose validator over his words and
  // the word "best" failed its ranking scan. The check is numeral
  // provenance only now; a reader's superlative is their criterion.
  it('the owner transcript passes: no numeral on either side, superlative and all', () => {
    const intent: ValidatedIntent = {
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
    }
    expect(
      checkSpokenNumbers('what city has the best schools but also has', intent).pass,
    ).toBe(true)
    expect(
      checkSpokenNumbers(
        'what city has the best schools but also has the lowest cost of living',
        intent,
      ).pass,
    ).toBe(true)
    expect(checkSpokenNumbers('what city has good schools', intent).pass).toBe(true)
  })

  it('generated prose is still policed by the full validator (protection intact)', () => {
    const v = createValidator()
    const ranking = v.validate('This city has the best schools.', [])
    expect(ranking.pass).toBe(false)
    if (!ranking.pass) expect(ranking.failure).toBe('banned_construction')
    const invented = v.validate('Rent is 2000 dollars.', [])
    expect(invented.pass).toBe(false)
    if (!invented.pass) expect(invented.failure).toBe('invented_numeral')
  })
})

describe('spoken-number reconciliation (the voice path never blocks)', () => {
  it('heard numerals scan digits and word forms', () => {
    expect(heardNumerals('rent under five thousand').map((n) => n.value)).toEqual([5000])
    expect(heardNumerals('the top one place').map((n) => n.value)).toEqual([1])
    expect(heardNumerals('burden over twenty percent').map((n) => n.value)).toEqual([20])
    expect(heardNumerals('what city has the best schools but also has')).toEqual([])
  })

  it('a matching spoken number keeps its filter: the request runs on the heard value', () => {
    const r = reconcileSpokenIntent('rent in Hilo under twenty five hundred', {
      ...sweepIntent,
      filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 2500 }],
    })
    expect(r.dropped).toEqual([])
    expect(r.intent.filters).toEqual([
      { metricKey: 'median_gross_rent', op: 'lt', value: 2500 },
    ])
    expect(r.unmatchedHeard).toEqual([])
  })

  it('an altered number resolves in favour of what was heard: the invented figure comes out', () => {
    const r = reconcileSpokenIntent('rent in Hilo under five thousand', sweepIntent)
    expect(r.dropped).toEqual([{ key: 'median_gross_rent', value: 2000 }])
    expect(r.intent.filters).toEqual([])
    expect(r.unmatchedHeard.map((n) => n.value)).toEqual([5000])
    // Geography is not a filter and is never touched.
    expect(r.intent.geographies).toEqual(['Hilo'])
  })

  it('a numeral-free transcript takes out every numeric filter (none of it was said)', () => {
    const r = reconcileSpokenIntent(
      'what city has the best schools but also has',
      sweepIntent,
    )
    expect(r.dropped).toEqual([{ key: 'median_gross_rent', value: 2000 }])
    expect(r.intent.filters).toEqual([])
    expect(r.unmatchedHeard).toEqual([])
  })

  it('a spoken percent keeps only the percent filter it cites', () => {
    const intent: ValidatedIntent = {
      mode: 'sweep_filter',
      geographies: ['Hilo'],
      metricKeys: ['median_rent_burden_pct', 'median_gross_rent'],
      filters: [
        { metricKey: 'median_rent_burden_pct', op: 'gt', value: 30 },
        { metricKey: 'median_gross_rent', op: 'lt', value: 2000 },
      ],
      clarificationNeeded: false,
    }
    const r = reconcileSpokenIntent('burden over thirty percent in Hilo', intent)
    expect(r.intent.filters).toEqual([
      { metricKey: 'median_rent_burden_pct', op: 'gt', value: 30 },
    ])
    expect(r.dropped).toEqual([{ key: 'median_gross_rent', value: 2000 }])
  })

  it('nothing to correct returns the intent untouched', () => {
    const r = reconcileSpokenIntent('compare Hilo and Honolulu rent', {
      ...sweepIntent,
      filters: [],
    })
    expect(r.dropped).toEqual([])
    expect(r.intent.filters).toEqual([])
  })
})
