import { describe, expect, it } from 'vitest'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'
import { detectGeographyGate } from '../../src/core/ai/geography-gate'

const intent = (metricKeys: string[]) =>
  ({ geographies: [] as string[], metricKeys, mode: 'sweep_filter' as const })

/**
 * Geography gate round 3 (2026-11-04): the tax specimen —
 * "which state has no income tax? or sales tax? and for those
 * states, which zip codes have the lowest cost of living?" —
 * decomposed to the cost criterion alone on the round-1 build:
 * the segment scan claimed the tax clause outright because the
 * measure-head word "income" appears inside the predicated noun
 * phrase, so no residue criterion existed for the gate to engage
 * on and the question fell to a state-average screen ranked by
 * an unasked measure. A state clause predicating an ABSENCE is a
 * classification, not a measure reading; these pins hold the
 * decomposition for the whole class.
 */

export const TAX_QUESTION =
  'which state has no income tax? or sales tax? and for those states, which zip codes have the lowest cost of living?'
export const PREDICATE_VARIANT =
  "which states have no sales tax, and what's the cheapest rent zip there?"

describe('geography gate round 3 — decomposition carries the classification', () => {
  it('the tax specimen decomposes to the cost criterion PLUS the tax residue criterion', () => {
    const criteria = decomposeResearchCriteria(TAX_QUESTION)
    const cost = criteria.find((c) => c.id === 'cost_of_living')
    expect(cost?.decomposedMetricKey).toBe('median_gross_rent')
    const combined = criteria.find((c) => c.id === 'combined')
    expect(combined).toBeDefined()
    expect(combined!.text).toBe('which state has no income tax? or sales tax')
    expect(combined!.decomposedMetricKey).toBeUndefined()
  })

  it('the single-criterion predicate variant decomposes to a combined criterion', () => {
    const criteria = decomposeResearchCriteria(PREDICATE_VARIANT)
    expect(criteria.map((c) => c.id)).toEqual(['combined'])
    expect(criteria[0]!.text).toBe(PREDICATE_VARIANT)
  })

  it('the FM-9 state-superlative pair still decomposes to nothing (no gate material)', () => {
    expect(decomposeResearchCriteria('Which state has the oldest population?')).toEqual([])
    expect(decomposeResearchCriteria('Which state has the youngest population?')).toEqual([])
  })

  it('the drug-law specimen decomposition is unchanged', () => {
    const criteria = decomposeResearchCriteria(
      'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?',
    )
    expect(criteria.map((c) => c.id)).toEqual(['cost_of_living', 'combined'])
    expect(criteria.find((c) => c.id === 'combined')!.text).toBe(
      'what state has the most relaxed drug laws -',
    )
  })
})

describe('geography gate round 3 — detection: predicate classifications engage', () => {
  it('the tax specimen engages on the absence-predicate clause + "for those states" bound', () => {
    const criteria = decomposeResearchCriteria(TAX_QUESTION)
    const spec = detectGeographyGate({
      queryText: TAX_QUESTION,
      intent: intent(['median_household_income']),
      researchCriteria: criteria,
    })
    expect(spec).not.toBeNull()
    expect(spec!.criterion.id).toBe('combined')
    expect(spec!.criterion.text).toBe('which state has no income tax? or sales tax')
  })

  it('the extremum metric is the decomposed asked measure, not the intent\u2019s first metric', () => {
    // A4 at the detection seam: the live parse led with household
    // income; the question's own decomposition maps "lowest cost of
    // living" to median_gross_rent, and that mapping wins.
    const criteria = decomposeResearchCriteria(TAX_QUESTION)
    const spec = detectGeographyGate({
      queryText: TAX_QUESTION,
      intent: intent(['median_household_income']),
      researchCriteria: criteria,
    })
    expect(spec!.extremumMetricKey).toBe('median_gross_rent')
  })

  it('the predicate variant engages on the closing "there" bound', () => {
    const criteria = decomposeResearchCriteria(PREDICATE_VARIANT)
    const spec = detectGeographyGate({
      queryText: PREDICATE_VARIANT,
      intent: intent(['median_gross_rent']),
      researchCriteria: criteria,
    })
    expect(spec).not.toBeNull()
    expect(spec!.extremumMetricKey).toBe('median_gross_rent')
  })

  it('a presence predicate whose criterion carries a favorable marker engages', () => {
    const q = "which states allow recreational marijuana, and what's the cheapest rent zip there?"
    const criteria = decomposeResearchCriteria(q)
    expect(criteria.some((c) => c.id === 'combined')).toBe(true)
    const spec = detectGeographyGate({
      queryText: q,
      intent: intent(['median_gross_rent']),
      researchCriteria: criteria,
    })
    expect(spec).not.toBeNull()
  })

  it('the FM-9 pair and the poverty question stay gateless through the full chain', () => {
    for (const q of [
      'Which state has the oldest population?',
      'Which state has the youngest population?',
      'Which state has the most poverty?',
    ]) {
      const spec = detectGeographyGate({
        queryText: q,
        intent: intent(['median_age']),
        researchCriteria: decomposeResearchCriteria(q),
      })
      expect(spec, q).toBeNull()
    }
  })

  it('an absence predicate with no dependent extremum does not engage', () => {
    const q = 'which state has no income tax?'
    const spec = detectGeographyGate({
      queryText: q,
      intent: intent([]),
      researchCriteria: decomposeResearchCriteria(q),
    })
    expect(spec).toBeNull()
  })
})
