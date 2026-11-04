import { describe, expect, it } from 'vitest'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'
import {
  buildGeographyGateContext,
  classifyStatesFromResearch,
  detectGeographyGate,
  gateBoundZctas,
} from '../../src/core/ai/geography-gate'

/**
 * Geography-gate pins (drug-law specimen cure, 2026-11-04): the
 * detection is structural (criterion classes, never criterion
 * topics), the classification is deterministic over the research
 * prose, and the counter-controls hold the per-place class on the
 * shipped flow.
 */
const SPECIMEN =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'

const specimenIntent = {
  geographies: [] as string[],
  metricKeys: ['median_gross_rent'],
  mode: 'sweep_filter' as const,
}

describe('detectGeographyGate', () => {
  it('engages on the specimen shape', () => {
    const criteria = decomposeResearchCriteria(SPECIMEN)
    const spec = detectGeographyGate({ queryText: SPECIMEN, intent: specimenIntent, researchCriteria: criteria })
    expect(spec).not.toBeNull()
    expect(spec!.criterion.id).toBe('combined')
    expect(spec!.criterion.decomposedMetricKey ?? null).toBeNull()
  })

  it('does not engage when the question names its geography', () => {
    const criteria = decomposeResearchCriteria(SPECIMEN)
    const spec = detectGeographyGate({
      queryText: SPECIMEN,
      intent: { ...specimenIntent, geographies: ['Colorado'] },
      researchCriteria: criteria,
    })
    expect(spec).toBeNull()
  })

  it('does not engage without the dependent bound', () => {
    const q = 'what state has the most relaxed drug laws?'
    const spec = detectGeographyGate({
      queryText: q,
      intent: specimenIntent,
      researchCriteria: decomposeResearchCriteria(q),
    })
    expect(spec).toBeNull()
  })

  it('does not engage for a per-place researched criterion (beer counter-control shape)', () => {
    const q = 'which city has good beer selection and low rent?'
    const spec = detectGeographyGate({
      queryText: q,
      intent: specimenIntent,
      researchCriteria: decomposeResearchCriteria(q),
    })
    expect(spec).toBeNull()
  })

  it('does not engage when the classifying criterion is a catalog criterion', () => {
    const q = 'what state has the best public schools - and the lowest cost of living in that state?'
    const criteria = decomposeResearchCriteria(q)
    expect(criteria.some((c) => c.id === 'schools')).toBe(true)
    const spec = detectGeographyGate({ queryText: q, intent: specimenIntent, researchCriteria: criteria })
    expect(spec).toBeNull()
  })

  it('does not engage with no Census extremum to bound', () => {
    const spec = detectGeographyGate({
      queryText: SPECIMEN,
      intent: { geographies: [], metricKeys: [], mode: 'lookup' as const },
      researchCriteria: decomposeResearchCriteria(SPECIMEN).filter((c) => !c.decomposedMetricKey),
    })
    // The specimen's own decomposition carries the cost criterion as
    // a decomposed metric; removing every decomposed criterion and
    // the intent metric leaves nothing for a gate to bound.
    expect(spec).toBeNull()
  })
})

const ROUNDUP =
  'As of 2025, recreational marijuana is fully legal in California, Illinois, Minnesota, Colorado, and Oregon. ' +
  'Texas and Florida have not legalized recreational use, and marijuana remains illegal in Idaho. ' +
  'Several sources describe Colorado as having the most relaxed drug laws in the country, with legal retail sales since 2014. ' +
  'In Wyoming, by contrast, the drug is illegal and possession is criminalized.'

describe('classifyStatesFromResearch', () => {
  const spec = detectGeographyGate({
    queryText: SPECIMEN,
    intent: specimenIntent,
    researchCriteria: decomposeResearchCriteria(SPECIMEN),
  })!

  it('classifies the favorable class from a list sentence', () => {
    const result = classifyStatesFromResearch(ROUNDUP, spec)
    const codes = result.favorableStates.map((s) => s.code)
    expect(codes).toEqual(expect.arrayContaining(['CA', 'IL', 'MN', 'CO', 'OR']))
    expect(codes).not.toContain('TX')
    expect(codes).not.toContain('FL')
    expect(codes).not.toContain('ID')
    expect(codes).not.toContain('WY')
  })

  it('names the singled-out winner state', () => {
    const result = classifyStatesFromResearch(ROUNDUP, spec)
    expect(result.winnerState?.code).toBe('CO')
  })

  it('keeps the classification sentences as claims', () => {
    const result = classifyStatesFromResearch(ROUNDUP, spec)
    expect(result.claims.length).toBeGreaterThanOrEqual(2)
    expect(result.claims.join(' ')).toContain('California')
  })

  it('returns no winner when no state is singled out', () => {
    const prose =
      'Recreational marijuana is fully legal in California, Illinois, and Minnesota. It is also legal in Oregon.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.winnerState).toBeNull()
    expect(result.favorableStates.map((s) => s.code)).toEqual(
      expect.arrayContaining(['CA', 'IL', 'MN', 'OR']),
    )
  })

  it('classifies on ", ST" suffixed mentions too', () => {
    const prose = 'Bridgeport, CA and Elizabethtown, IL are in states where recreational use is legal.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(expect.arrayContaining(['CA', 'IL']))
  })

  it('flips the pole for a restrictive superlative', () => {
    const strictSpec = detectGeographyGate({
      queryText:
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      intent: specimenIntent,
      researchCriteria: decomposeResearchCriteria(
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      ),
    })!
    const prose =
      'Marijuana remains illegal in Idaho and Wyoming, where possession is criminalized. Recreational use is legal in Colorado.'
    const result = classifyStatesFromResearch(prose, strictSpec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(expect.arrayContaining(['ID', 'WY']))
    expect(result.favorableStates.map((s) => s.code)).not.toContain('CO')
  })
})

describe('buildGeographyGateContext + gateBoundZctas', () => {
  const spec = detectGeographyGate({
    queryText: SPECIMEN,
    intent: specimenIntent,
    researchCriteria: decomposeResearchCriteria(SPECIMEN),
  })!
  const sources = [{ title: 'State cannabis laws roundup', url: 'https://example.org/roundup' }]

  it('bounds to the winner alone when one is singled out', () => {
    const ctx = buildGeographyGateContext({
      spec,
      classification: classifyStatesFromResearch(ROUNDUP, spec),
      sources,
    })!
    expect(ctx.winnerState?.code).toBe('CO')
    expect(ctx.boundStates.map((s) => s.code)).toEqual(['CO'])
    expect(ctx.classifiedStates.length).toBeGreaterThanOrEqual(5)
    expect(ctx.claims[0]!.sourceUrls).toEqual(['https://example.org/roundup'])
  })

  it('bounds to the full favorable class when no winner is singled out', () => {
    const ctx = buildGeographyGateContext({
      spec,
      classification: classifyStatesFromResearch(
        'Recreational marijuana is fully legal in California, Illinois, and Minnesota.',
        spec,
      ),
      sources,
    })!
    expect(ctx.winnerState).toBeNull()
    expect(ctx.boundStates.map((s) => s.code)).toEqual(['CA', 'IL', 'MN'])
  })

  it('returns null on an empty classification', () => {
    const ctx = buildGeographyGateContext({
      spec,
      classification: classifyStatesFromResearch('No states were characterized.', spec),
      sources,
    })
    expect(ctx).toBeNull()
  })

  it('collects only the bound states ZCTAs from rows', () => {
    const rows = [
      { zcta: '40701', name: 'Corbin, KY' },
      { zcta: '95965', name: 'Oroville, CA' },
      { zcta: '90001', name: 'Los Angeles, CA' },
      { zcta: '62901', name: 'Carbondale, IL' },
    ]
    const zctas = gateBoundZctas(rows, [
      { code: 'CA', name: 'California' },
      { code: 'IL', name: 'Illinois' },
    ])
    expect([...zctas].sort()).toEqual(['62901', '90001', '95965'])
  })
})
