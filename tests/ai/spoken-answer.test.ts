import { describe, expect, it } from 'vitest'
import type { ComposedAnswer } from '../../src/core/ai/answer'
import {
  composeSpokenSummary,
  guardSpokenSentences,
  verifiedFiguresFromAnswer,
} from '../../src/ui/ai/spoken-answer'

/**
 * Spoken-answer composer (C10 branch b): the spoken summary is built
 * only from a verified answer's parts, and a numeral may be spoken
 * only when it is in the verified figure list passed in by reference.
 */

function verifiedAnswer(partial: Partial<ComposedAnswer> = {}): ComposedAnswer {
  return {
    status: 'verified',
    stage: 'verify',
    criteria: [
      { metricKey: 'median_gross_rent', bound: 'atMost', value: 1500, intentOp: 'lt' },
    ],
    droppedCriteria: [],
    unresolvedGeographies: [],
    screenedCount: 4,
    places: [
      {
        zcta: '96720',
        name: 'Hilo, HI',
        figures: [{ key: 'median_gross_rent', value: 1450, marginOfError: 85 }],
        claims: [],
      },
    ],
    generalClaims: [],
    sources: [],
    summary:
      'The places named here meet all of the stated Census criteria, with the deciding figures shown from Census data.',
    droppedClaims: [],
    failures: [],
    researchCriteria: [
      { id: 'schools', label: 'School quality', text: 'best schools', quantitative: false },
    ],
    criterionEvidence: [
      {
        criterion: 'median_gross_rent',
        kind: 'census',
        status: 'met',
        detail: 'Measured from Census figures shown for each named place.',
        sourceUrls: [],
      },
      {
        criterion: 'School quality',
        kind: 'research',
        status: 'partially_measured',
        detail: 'A cited source speaks to this criterion in qualitative terms only.',
        sourceUrls: ['https://example.test/schools'],
      },
    ],
    candidateCap: 10,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'national',
    unsupportedGeography: null,
    requestedCount: null,
    ...partial,
  }
}

describe('composeSpokenSummary', () => {
  it('speaks the headline, then one sentence per criterion', () => {
    const sentences = composeSpokenSummary(verifiedAnswer())
    expect(sentences[0]).toContain('meet all of the stated Census criteria')
    expect(sentences).toHaveLength(3)
    expect(sentences[1]).toContain('median gross rent')
    expect(sentences[2]).toBe('School quality: partially measured.')
  })

  it('speaks a verified figure, copied from the verified list by reference', () => {
    const answer = verifiedAnswer()
    const sentences = composeSpokenSummary(answer, verifiedFiguresFromAnswer(answer))
    // 1450 is the Hilo figure on the card, in the verified list.
    expect(sentences[1]).toBe(
      'median gross rent: measured, 1,450 for Hilo, HI.',
    )
  })

  it('does not speak a figure that is not in the verified list passed in', () => {
    const answer = verifiedAnswer()
    // The same answer, but the caller passes an empty verified list:
    // the figure clause must disappear rather than read from prose.
    const sentences = composeSpokenSummary(answer, [])
    expect(sentences.join(' ')).not.toContain('1450')
    expect(sentences.join(' ')).not.toContain('1,450')
    expect(sentences[1]).toBe('median gross rent: measured.')
  })

  it('blocks an unverified numeral that appears in headline prose', () => {
    const answer = verifiedAnswer({
      summary: 'The places named here include one with rent of 999 dollars.',
    })
    const sentences = composeSpokenSummary(answer, verifiedFiguresFromAnswer(answer))
    // The headline sentence is dropped whole; the criterion
    // sentences, which carry no unverified numeral, still speak.
    expect(sentences.join(' ')).not.toContain('999')
    expect(sentences.some((s) => s.startsWith('median gross rent'))).toBe(true)
  })

  it('blocks an unverified number-word numeral in prose', () => {
    const answer = verifiedAnswer({
      summary: 'Nine hundred ninety nine places were considered in prose.',
    })
    const sentences = composeSpokenSummary(answer, [])
    expect(sentences.join(' ').toLowerCase()).not.toContain('nine hundred')
  })

  it('speaks criterion outcomes without numerals when no figure is verified', () => {
    const answer = verifiedAnswer({
      places: [],
      criterionEvidence: [
        {
          criterion: 'School quality',
          kind: 'research',
          status: 'not_measurable',
          detail: 'No cited source available here speaks to this criterion.',
          sourceUrls: [],
        },
      ],
    })
    const sentences = composeSpokenSummary(answer, [])
    expect(sentences).toContain(
      'School quality: not measurable from available sources.',
    )
    expect(sentences.join(' ')).not.toMatch(/\d/)
  })

  it('an empty answer produces no speech', () => {
    const empty = verifiedAnswer({
      status: 'empty',
      summary: 'No place in the loaded data meets all of the stated Census criteria.',
      places: [],
      criterionEvidence: [],
    })
    expect(composeSpokenSummary(empty)).toEqual([])
  })

  it('a withheld or blocked answer produces no speech', () => {
    expect(composeSpokenSummary(verifiedAnswer({ status: 'withheld' }))).toEqual([])
    expect(composeSpokenSummary(verifiedAnswer({ status: 'blocked' }))).toEqual([])
  })
})

describe('guardSpokenSentences', () => {
  it('keeps a sentence whose numeral is verified, at spoken rounding', () => {
    expect(
      guardSpokenSentences(['Rent is 1,450 dollars.'], [
        { key: 'median_gross_rent', value: 1450 },
      ]),
    ).toEqual(['Rent is 1,450 dollars.'])
  })

  it('drops a sentence whose numeral is not in the verified set', () => {
    expect(
      guardSpokenSentences(['Rent is 1,500 dollars.', 'No figures here.'], [
        { key: 'median_gross_rent', value: 1450 },
      ]),
    ).toEqual(['No figures here.'])
  })
})

describe('verifiedFiguresFromAnswer', () => {
  it('derives the list from the figures on the answer places only', () => {
    expect(verifiedFiguresFromAnswer(verifiedAnswer())).toEqual([
      { key: 'median_gross_rent', value: 1450 },
    ])
  })
})
