import { describe, expect, it } from 'vitest'
import { composeGeneralSpokenHeadline } from '../../src/ui/ai/spoken-answer'
import { GENERAL_SPOKEN_CLASS_LINE } from '../../src/core/ai/general'

/**
 * Lane completion K6: the general lane's spoken headline. The
 * spoken form carries only the derivation class (code-composed),
 * the precision-limit clause when the terminal carries one
 * (code-authored), and the shipped text's first sentences that
 * pass the spoken-number guard with an empty verified list —
 * every numeral-bearing sentence is suppressed, so a model
 * estimate is never spoken as a figure.
 */
describe('K6 general-lane spoken headline', () => {
  it('speaks the class line ahead of the first two figure-free sentences', () => {
    const out = composeGeneralSpokenHeadline({
      text: 'Photosynthesis converts sunlight into chemical energy in plants. It sustains nearly all life on Earth. A third sentence is not part of the headline.',
      precisionLimit: null,
    })
    expect(out).toEqual([
      GENERAL_SPOKEN_CLASS_LINE,
      'Photosynthesis converts sunlight into chemical energy in plants.',
      'It sustains nearly all life on Earth.',
    ])
  })

  it('suppresses numeral-bearing sentences, digits and number words alike', () => {
    const out = composeGeneralSpokenHeadline({
      text: 'The city was founded in 1836 and grew quickly. Three rail lines converged there by the century\u2019s end. Its market square remains the civic center today.',
      precisionLimit: null,
    })
    expect(out).toEqual([
      GENERAL_SPOKEN_CLASS_LINE,
      'Its market square remains the civic center today.',
    ])
  })

  it('speaks nothing when no headline sentence passes the guard', () => {
    const out = composeGeneralSpokenHeadline({
      text: 'About 40 percent of the budget goes to roads. Another 25 percent funds schools.',
      precisionLimit: null,
    })
    expect(out).toEqual([])
  })

  it('carries the precision-limit clause verbatim when the terminal carries one', () => {
    const limit =
      'Precision limit: this answer is an estimate under the stated assumptions, not an exact count.'
    const out = composeGeneralSpokenHeadline({
      text: 'A rough tally suggests the valley holds more orchards than vineyards.',
      precisionLimit: limit,
    })
    expect(out).toEqual([
      GENERAL_SPOKEN_CLASS_LINE,
      limit,
      'A rough tally suggests the valley holds more orchards than vineyards.',
    ])
  })

  it('the class line is figure-free under the guard\u2019s own numeral scan', () => {
    // The class line is prepended after the guard runs; this pin
    // holds it to the same standard as guarded content — if the
    // line ever gains a numeral, it must not ride past the gate.
    const out = composeGeneralSpokenHeadline({
      text: 'Fermentation turns grape juice into wine through yeast activity.',
      precisionLimit: null,
    })
    expect(out[0]).toBe(GENERAL_SPOKEN_CLASS_LINE)
    expect(/\d/.test(GENERAL_SPOKEN_CLASS_LINE)).toBe(false)
    expect(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b/i.test(
        GENERAL_SPOKEN_CLASS_LINE,
      ),
    ).toBe(false)
  })
})
