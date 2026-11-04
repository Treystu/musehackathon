import { describe, expect, it } from 'vitest'
import { criterionEvidenceFor, decomposeResearchCriteria } from '../../src/core/ai/answer'
import {
  buildGeographyGateContext,
  classifyStatesFromResearch,
  detectGeographyGate,
  gateClassificationQueryText,
  parsePredicateAlternatives,
} from '../../src/core/ai/geography-gate'

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

const taxSpec = () =>
  detectGeographyGate({
    queryText: TAX_QUESTION,
    intent: intent(['median_gross_rent']),
    researchCriteria: decomposeResearchCriteria(TAX_QUESTION),
  })!

describe('geography gate round 3 — predicate alternatives parse', () => {
  it('the disjunction splits into two negated alternatives (negation distributes)', () => {
    const alternatives = parsePredicateAlternatives('which state has no income tax? or sales tax')
    expect(alternatives).toEqual([
      { label: 'no income tax', phrase: 'income tax', negated: true },
      { label: 'no sales tax', phrase: 'sales tax', negated: true },
    ])
  })

  it('the variant\u2019s whole-question criterion text parses to its one alternative', () => {
    expect(parsePredicateAlternatives(PREDICATE_VARIANT)).toEqual([
      { label: 'no sales tax', phrase: 'sales tax', negated: true },
    ])
  })

  it('superlative criteria never parse as predicate alternatives', () => {
    expect(parsePredicateAlternatives('what state has the most relaxed drug laws -')).toBeNull()
    expect(parsePredicateAlternatives('states with the strictest drug laws')).toBeNull()
  })

  it('the classification ask enumerates each alternative separately', () => {
    const ask = gateClassificationQueryText(TAX_QUESTION, taxSpec())
    expect(ask).toContain('For the state part of the question')
    expect(ask).toContain('For the part "no income tax"')
    expect(ask).toContain('For the part "no sales tax"')
    expect(ask).toContain('each part of the criterion separately')
  })
})

const TAX_PROSE = [
  'Nine states have no income tax: Alaska, Florida, Nevada, New Hampshire, South Dakota, Tennessee, Texas, Washington, and Wyoming.',
  'Alaska has no statewide sales tax.',
  'Delaware has no sales tax.',
  'Montana has no general sales tax.',
  'New Hampshire has no sales tax on goods.',
  'Oregon does not levy a sales tax.',
  'California has a state income tax, with top rates above 13 percent.',
  'California also has a state sales tax.',
].join(' ')

describe('geography gate round 3 — per-alternative classification', () => {
  it('classifies each alternative\u2019s set separately; the bound is the union', () => {
    const classification = classifyStatesFromResearch(TAX_PROSE, taxSpec())
    const byLabel = new Map(classification.alternatives!.map((a) => [a.label, a.states.map((s) => s.code)]))
    expect(byLabel.get('no income tax')).toEqual([
      'AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY',
    ])
    expect(byLabel.get('no sales tax')).toEqual(['AK', 'DE', 'MT', 'NH', 'OR'])
    // The union: 9 + 5 - the two overlaps (AK, NH) = 12, each once.
    expect(classification.favorableStates.map((s) => s.code)).toEqual([
      'AK', 'DE', 'FL', 'MT', 'NV', 'NH', 'OR', 'SD', 'TN', 'TX', 'WA', 'WY',
    ])
    expect(classification.winnerState).toBeNull()
    // Presence assertions classify nothing: California is nowhere.
    expect(classification.favorableStates.some((s) => s.code === 'CA')).toBe(false)
  })

  it('the context carries the alternatives and bounds the union', () => {
    const classification = classifyStatesFromResearch(TAX_PROSE, taxSpec())
    const context = buildGeographyGateContext({
      spec: taxSpec(),
      classification,
      sources: [{ title: 'Tax roundup', url: 'https://example.test/taxes' }],
    })
    expect(context).not.toBeNull()
    expect(context!.alternatives).toHaveLength(2)
    expect(context!.boundStates).toHaveLength(12)
    expect(context!.winnerState).toBeNull()
  })

  it('prose supporting only a narrow set classifies narrowly, per alternative', () => {
    const classification = classifyStatesFromResearch(
      'Only Alaska has no income tax. Every other state levies an income tax of some form.',
      taxSpec(),
    )
    const byLabel = new Map(classification.alternatives!.map((a) => [a.label, a.states.map((s) => s.code)]))
    expect(byLabel.get('no income tax')).toEqual(['AK'])
    expect(byLabel.get('no sales tax')).toEqual([])
    expect(classification.favorableStates.map((s) => s.code)).toEqual(['AK'])
  })

  it('the criterion evidence accounts part by part, naming the overlap and the union', () => {
    const classification = classifyStatesFromResearch(TAX_PROSE, taxSpec())
    const context = buildGeographyGateContext({
      spec: taxSpec(),
      classification,
      sources: [{ title: 'Tax roundup', url: 'https://example.test/taxes' }],
    })!
    const evidence = criterionEvidenceFor({
      criteria: [],
      droppedCriteria: [],
      places: [],
      claims: [],
      unsupportedGeography: null,
      // The pipeline retires the classifying criterion from the
      // research list (its service is the classification), so the
      // evidence input carries the decomposition without it.
      researchCriteria: decomposeResearchCriteria(TAX_QUESTION).filter(
        (c) => c.id !== 'combined',
      ),
      geographyGate: context,
    })
    const gateEntry = evidence.find((e) => e.criterion === context.criterionLabel)
    expect(gateEntry).toBeDefined()
    expect(gateEntry!.detail).toContain('part by part')
    expect(gateEntry!.detail).toContain('No income tax:')
    expect(gateEntry!.detail).toContain('(9 states)')
    expect(gateEntry!.detail).toContain('No sales tax:')
    expect(gateEntry!.detail).toContain('(5 states)')
    expect(gateEntry!.detail).toContain('Alaska, New Hampshire meet more than one part')
    expect(gateEntry!.detail).toContain('the union of 12 states')
  })
})
