import { describe, expect, it } from 'vitest'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'

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
