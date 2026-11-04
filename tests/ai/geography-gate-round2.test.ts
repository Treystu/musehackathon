import { describe, expect, it } from 'vitest'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'
import {
  classifyStatesFromResearch,
  detectGeographyGate,
  gateClassificationQueryText,
} from '../../src/core/ai/geography-gate'

/**
 * Geography-gate round 2 (2026-11-04): classification robustness.
 * Live on 2e04268 the gate mechanism worked (the screen ran inside
 * the classified set) but the classification itself collapsed to
 * ONE state: the research prose centered its narrative on Oregon
 * (decriminalization) and the round-1 sentence classifier followed
 * the focus, even though the prose carried the favorable class as
 * an enumeration. These pins hold the cure: the classification ask
 * requires the domain-wide enumeration, and the classifier honors
 * an announced (counted/listed) class as a class — while prose
 * that genuinely supports only a narrow class still classifies
 * narrowly.
 */
const SPECIMEN =
  'what state has the most relaxed drug laws - and which city/county/zip has the lowest cost of living in that state?'

const specimenIntent = {
  geographies: [] as string[],
  metricKeys: ['median_gross_rent'],
  mode: 'sweep_filter' as const,
}

const spec = detectGeographyGate({
  queryText: SPECIMEN,
  intent: specimenIntent,
  researchCriteria: decomposeResearchCriteria(SPECIMEN),
})!

describe('gateClassificationQueryText (round 2)', () => {
  it('requires the domain-wide enumeration, not a focus', () => {
    const q = gateClassificationQueryText(SPECIMEN, spec)
    expect(q.startsWith(SPECIMEN)).toBe(true)
    // The runner/traversal stub keys on this opener; it is stable.
    expect(q).toContain('For the state part of the question')
    expect(q).toContain('state by state')
    expect(q).toContain('enumerate every U.S. state')
    expect(q).toContain('rather than focusing on any single state')
    expect(q).toContain('name any single state the sources identify as the strongest example')
  })
})

/**
 * The live failure shape, reconstructed: narrative sentences about
 * Oregon (which classify Oregon on their own), then the favorable
 * class carried as a counted lead + colon lead + one comma-run
 * list whose items carry no marker of their own.
 */
const OREGON_FOCUSED =
  'Oregon has long been a pioneer on drug policy. ' +
  'Oregon decriminalized possession of small amounts of drugs in 2020, a first-in-the-nation step that drew national attention. ' +
  'Much of the coverage of relaxed drug laws centers on Oregon and its decriminalization experiment. ' +
  'As of 2025, recreational marijuana is fully legal in 24 states. ' +
  'The states where recreational marijuana is fully legal include: ' +
  'Alaska, Arizona, California, Colorado, Connecticut, Delaware, Illinois, Maine, Maryland, Massachusetts, Michigan, Minnesota, Missouri, Montana, Nevada, New Jersey, New Mexico, New York, Ohio, Oregon, Rhode Island, Vermont, Virginia, and Washington. ' +
  'Marijuana remains illegal in Idaho and Wyoming.'

describe('classifyStatesFromResearch — enumerated class outranks focus (round 2)', () => {
  it('classifies the enumerated class, not Oregon alone', () => {
    const result = classifyStatesFromResearch(OREGON_FOCUSED, spec)
    const codes = result.favorableStates.map((s) => s.code)
    expect(codes.length).toBe(24)
    expect(codes).toEqual(
      expect.arrayContaining(['AK', 'CA', 'CO', 'IL', 'MN', 'NJ', 'NY', 'OR', 'WA']),
    )
    expect(codes).not.toContain('ID')
    expect(codes).not.toContain('WY')
    // The prose singles out no state as the strongest: no winner.
    expect(result.winnerState).toBeNull()
    // The enumeration sentences ride as cited claims.
    expect(result.claims.join(' ')).toContain('fully legal in 24 states')
    expect(result.claims.join(' ')).toContain('Alaska, Arizona, California')
  })

  it('collects a headed bare list under a colon lead-in', () => {
    const prose =
      'Coverage of the issue tends to focus on Oregon, which decriminalized marijuana possession back in 1973. ' +
      'States where recreational marijuana is fully legal:\n' +
      'California\nColorado\nIllinois\nMinnesota\n' +
      'In Idaho, by contrast, marijuana remains illegal.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['CA', 'CO', 'IL', 'MN', 'OR'])
    expect(result.winnerState).toBeNull()
  })

  it('keeps a genuinely narrow classification narrow (no invention)', () => {
    const prose =
      'Oregon decriminalized possession of small amounts in 1973 and remains the focus of the national decriminalization debate. ' +
      'No other state has adopted the same approach, and marijuana remains illegal in Idaho and Wyoming.'
    const result = classifyStatesFromResearch(prose, spec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['OR'])
    expect(result.winnerState).toBeNull()
  })

  it('honors an announced enumeration on the flipped (restrictive) pole', () => {
    const strictSpec = detectGeographyGate({
      queryText:
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      intent: specimenIntent,
      researchCriteria: decomposeResearchCriteria(
        'what state has the strictest drug laws - and which city has the lowest cost of living in that state?',
      ),
    })!
    const prose =
      'States where marijuana remains illegal include: Idaho, Wyoming, and Nebraska. ' +
      'Recreational use is legal in Colorado.'
    const result = classifyStatesFromResearch(prose, strictSpec)
    expect(result.favorableStates.map((s) => s.code)).toEqual(['ID', 'NE', 'WY'])
    expect(result.favorableStates.map((s) => s.code)).not.toContain('CO')
  })
})
