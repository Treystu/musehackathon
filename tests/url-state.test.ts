/**
 * URL-carried comparisons, pinned.
 *
 * The assertions follow from the one constraint this feature has: a share link
 * carries the sender's selected ZIP codes and nothing else, and everything in it
 * is untrusted input. Encode/decode round-trip is table stakes; the tests that
 * matter are the ones where a hand-edited or hostile URL meets the decoder, and
 * the ones proving a link never smuggles a choice about how to look at data.
 */
import { describe, expect, it } from 'vitest'

import {
  COMPARISON_PARAM,
  decodeComparison,
  decodeUrl,
  encodeComparison,
  MAX_SHARED,
  urlForSelection,
} from '../src/core/url-state'

describe('encoding', () => {
  it('round-trips a selection', () => {
    const zips = ['10001', '78701', '60601']
    expect(decodeComparison(encodeComparison(zips))).toEqual(['10001', '60601', '78701'])
  })

  it('is canonical: the same selection always produces the same link', () => {
    // Order does not survive, on purpose — the comparison has no meaningful
    // order, and a canonical form means two people sharing the same set of
    // areas produce character-identical links.
    expect(encodeComparison(['78701', '10001'])).toBe(encodeComparison(['10001', '78701']))
  })

  it('drops duplicates and non-ZIP entries rather than passing them through', () => {
    expect(encodeComparison(['78701', 'banana', '78701'])).toBe('78701')
  })

  it('produces no parameter for an empty selection', () => {
    expect(encodeComparison([])).toBeNull()
    expect(encodeComparison(['nonsense'])).toBeNull()
  })

  it('caps what it will carry, so a URL cannot become a database', () => {
    const many = Array.from({ length: 40 }, (_, i) => String(10000 + i).slice(0, 5))
    const encoded = encodeComparison(many)!
    expect(decodeComparison(encoded)).toHaveLength(MAX_SHARED)
  })
})

describe('decoding untrusted input', () => {
  it('accepts a well-formed parameter', () => {
    expect(decodeComparison('78701,10001')).toEqual(['10001', '78701'])
  })

  it('drops invalid entries silently and keeps the valid ones', () => {
    expect(decodeComparison('78701,banana,;<script>,10001')).toEqual(['10001', '78701'])
  })

  it('treats null, empty and pure-noise as "nothing selected"', () => {
    expect(decodeComparison(null)).toEqual([])
    expect(decodeComparison('')).toEqual([])
    expect(decodeComparison(',,,,')).toEqual([])
    expect(decodeComparison('not-a-zip')).toEqual([])
  })

  it('trims whitespace, because hand-edited URLs get stray spaces', () => {
    expect(decodeComparison(' 78701 , 10001 ')).toEqual(['10001', '78701'])
  })

  it('decodes from a full URL', () => {
    expect(decodeUrl(`https://x.dev/?${COMPARISON_PARAM}=78701,10001&preset=budget`)).toEqual([
      '10001',
      '78701',
    ])
    // A preset in a shared URL is ignored on arrival: a link carries what the
    // sender saw, not how they chose to look at it.
    expect(decodeUrl('https://x.dev/?preset=cheap')).toEqual([])
    expect(decodeUrl('https://x.dev/')).toEqual([])
  })
})

describe('urlForSelection', () => {
  it('sets the parameter', () => {
    const out = urlForSelection('https://x.dev/', ['78701', '10001'])
    expect(out).toBe(`https://x.dev/?${COMPARISON_PARAM}=10001,78701`)
  })

  it('clears the parameter when the selection empties', () => {
    const out = urlForSelection(`https://x.dev/?${COMPARISON_PARAM}=10001`, [])
    expect(out).toBe('https://x.dev/')
  })

  it('preserves unrelated parameters', () => {
    const out = urlForSelection('https://x.dev/?preset=cheap', ['78701'])
    expect(new URL(out).searchParams.get('preset')).toBe('cheap')
  })

  it('returns the input unchanged when nothing would change', () => {
    const same = `https://x.dev/?${COMPARISON_PARAM}=10001`
    expect(urlForSelection(same, ['10001'])).toBe(same)
    expect(urlForSelection('https://x.dev/', [])).toBe('https://x.dev/')
  })

  it('returns the input when the URL is not parseable, rather than throwing', () => {
    expect(urlForSelection('not a url', ['78701'])).toBe('not a url')
  })
})
