import { describe, expect, it } from 'vitest'
import {
  INTENT_URL_PARAM,
  intentFromSearch,
  serializeIntentParam,
  withIntentParam,
} from '../../src/core/ai/intent-url'
import type { ValidatedIntent } from '../../src/core/ai/provider'

const LOOKUP: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const COMPARE: ValidatedIntent = {
  mode: 'compare',
  geographies: ['Hilo', 'Honolulu'],
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}

const SWEEP: ValidatedIntent = {
  mode: 'sweep_filter',
  geographies: ['HI'],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

function roundTrip(intent: ValidatedIntent): ValidatedIntent | null {
  return intentFromSearch(withIntentParam('', intent))
}

function encodeRaw(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('intent URL state', () => {
  it('round-trips a lookup intent', () => {
    expect(roundTrip(LOOKUP)).toEqual(LOOKUP)
  })

  it('round-trips a compare intent', () => {
    expect(roundTrip(COMPARE)).toEqual(COMPARE)
  })

  it('round-trips a sweep intent with its filter', () => {
    expect(roundTrip(SWEEP)).toEqual(SWEEP)
  })

  it('round-trips non-ASCII geography names', () => {
    const intent: ValidatedIntent = {
      ...LOOKUP,
      geographies: ['Kailua-Kona'],
    }
    expect(roundTrip(intent)).toEqual(intent)
  })

  it('is additive: other parameters survive and are preserved', () => {
    const search = withIntentParam('?view=map&tab=figures', LOOKUP)
    const params = new URLSearchParams(search)
    expect(params.get('view')).toBe('map')
    expect(params.get('tab')).toBe('figures')
    expect(intentFromSearch(search)).toEqual(LOOKUP)
  })

  it('replaces a stale intent parameter instead of stacking', () => {
    const first = withIntentParam('', LOOKUP)
    const second = withIntentParam(first, COMPARE)
    const params = new URLSearchParams(second)
    expect(params.getAll(INTENT_URL_PARAM)).toHaveLength(1)
    expect(intentFromSearch(second)).toEqual(COMPARE)
  })

  it('returns null when the parameter is absent', () => {
    expect(intentFromSearch('')).toBeNull()
    expect(intentFromSearch('?view=map')).toBeNull()
  })

  it.each([
    ['not base64url at all', 'intent=!!!bogus!!!'],
    ['base64 of non-JSON', `intent=${encodeRaw('hello there')}`],
    ['JSON of the wrong shape', `intent=${encodeRaw('{"mode":"lookup"}')}`],
    [
      'unknown metric key',
      `intent=${encodeRaw(
        JSON.stringify({ ...LOOKUP, metricKeys: ['fabricated_metric'] }),
      )}`,
    ],
    [
      'mode outside the closed enum',
      `intent=${encodeRaw(JSON.stringify({ ...LOOKUP, mode: 'rank' }))}`,
    ],
    [
      'proxy metric in a filter',
      `intent=${encodeRaw(
        JSON.stringify({
          ...SWEEP,
          filters: [{ metricKey: 'renter_occupied', op: 'gt', value: 10 }],
        }),
      )}`,
    ],
    ['truncated value', `intent=${serializeIntentParam(LOOKUP).slice(0, 8)}`],
  ])('ignores an invalid parameter: %s', (_label, search) => {
    expect(intentFromSearch(search)).toBeNull()
  })

  it('ignores an oversized parameter', () => {
    expect(intentFromSearch(`intent=${'A'.repeat(5000)}`)).toBeNull()
  })

  it('never restores a blind runnable claim: runnability is re-stamped', () => {
    // The serialized intent claims no clarification is needed, but it
    // carries no geography, so the restored intent must come back
    // flagged for clarification — nothing executes straight off a URL.
    const claimed: ValidatedIntent = {
      mode: 'lookup',
      geographies: [],
      metricKeys: ['median_gross_rent'],
      filters: [],
      clarificationNeeded: false,
    }
    const restored = intentFromSearch(withIntentParam('', claimed))
    expect(restored).not.toBeNull()
    expect(restored?.clarificationNeeded).toBe(true)
  })
})
