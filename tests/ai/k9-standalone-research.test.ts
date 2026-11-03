import { describe, expect, it } from 'vitest'
import { filterStandaloneResearchProse } from '../../src/ui/ai/AskPanel'

/**
 * Lane completion K9 (iii): the standalone research section
 * renders its stored prose verbatim, so the model's working
 * narration could head the "From the web" findings raw. The
 * stored prose now passes compose's narration filter per
 * paragraph — the same class the answer-card path drops.
 */
const SOURCES = [{ title: 'Coffee guide', url: 'https://example.org/coffee' }]

describe('K9 standalone research prose filter', () => {
  it('drops a first-person narration lead and keeps the finding', () => {
    const out = filterStandaloneResearchProse(
      'I\u2019ll research the coffee scene for you.\n\nTraverse City is praised for its coffee roasters and cafe density.',
      SOURCES,
    )
    expect(out).toBe('Traverse City is praised for its coffee roasters and cafe density.')
  })

  it('drops an interim-standing paragraph and preserves the paragraph shape', () => {
    const out = filterStandaloneResearchProse(
      'Austin is described by several guides as the state\u2019s most liberal city.\n\nInitial results point to Austin.\n\nCrystal City\u2019s council record is cited as the strongest support.',
      SOURCES,
    )
    expect(out).toBe(
      'Austin is described by several guides as the state\u2019s most liberal city.\n\nCrystal City\u2019s council record is cited as the strongest support.',
    )
  })

  it('an all-narration return filters to empty (stored as unavailable)', () => {
    const out = filterStandaloneResearchProse(
      'Let me look into that for you. I\u2019ll check the guides and compare the towns.',
      SOURCES,
    )
    expect(out).toBe('')
  })

  it('clean findings prose passes through unchanged', () => {
    const prose =
      'Naperville is cited for its school district ratings.\n\nEvanston is cited for its library system.'
    expect(filterStandaloneResearchProse(prose, SOURCES)).toBe(prose)
  })
})
