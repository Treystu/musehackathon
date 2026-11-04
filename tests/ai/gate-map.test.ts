import { describe, expect, it } from 'vitest'
import type { ComposedAnswer } from '../../src/core/ai/answer'
import { gateMapModel } from '../../src/core/map/gate-map'
import { resultMapRelevant, terminalChartKinds } from '../../src/core/map/result-scale'

/**
 * Gate map pins (drug-law specimen cure, 2026-11-04): the map for a
 * geography-gated answer frames the QUALIFYING STATES shaded by
 * their cheapest screened figure — and the wrong-geography
 * choropleth (the unbounded screen's cheapest ZIPs) is suppressed
 * for the class, never substituted.
 */
const BASEMAP_STATES = [
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'IL', name: 'Illinois' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'OR', name: 'Oregon' },
]

function gateAnswer(partial: Partial<ComposedAnswer> = {}): ComposedAnswer {
  return {
    status: 'verified',
    stage: 'verify',
    criteria: [],
    droppedCriteria: [],
    unresolvedGeographies: [],
    screenedCount: 8,
    places: [
      {
        zcta: '56591',
        name: 'White Earth, MN',
        figures: [{ key: 'median_gross_rent', value: 198 }],
        claims: [],
      },
      {
        zcta: '93517',
        name: 'Bridgeport, CA',
        figures: [{ key: 'median_gross_rent', value: 225 }],
        claims: [],
      },
    ],
    generalClaims: [],
    sources: [],
    summary: '',
    droppedClaims: [],
    failures: [],
    researchCriteria: [],
    criterionEvidence: [],
    candidateCap: 10,
    candidateCapApplied: false,
    unresolvedCandidates: [],
    geographyLevel: 'national',
    unsupportedGeography: null,
    requestedCount: null,
    countyMethod: null,
    notMeasurableCounties: [],
    geographyDisclosures: [],
    stateMethod: null,
    geographyGate: {
      criterionLabel: 'Outside-Census criteria',
      headlineKey: 'median_gross_rent',
      boundStates: [
        { code: 'CA', name: 'California' },
        { code: 'CO', name: 'Colorado' },
        { code: 'IL', name: 'Illinois' },
        { code: 'MN', name: 'Minnesota' },
        { code: 'OR', name: 'Oregon' },
      ],
      classifiedStates: [
        { code: 'CA', name: 'California' },
        { code: 'CO', name: 'Colorado' },
        { code: 'IL', name: 'Illinois' },
        { code: 'MN', name: 'Minnesota' },
        { code: 'OR', name: 'Oregon' },
      ],
      winnerState: null,
      standings: [
        { code: 'CA', name: 'California', cheapestRent: 225, cheapestPlaceName: 'Bridgeport, CA', cheapestZcta: '93517' },
        { code: 'CO', name: 'Colorado', cheapestRent: 210, cheapestPlaceName: 'Crested Butte, CO', cheapestZcta: '81224' },
        { code: 'IL', name: 'Illinois', cheapestRent: 235, cheapestPlaceName: 'Elizabethtown, IL', cheapestZcta: '62931' },
        { code: 'MN', name: 'Minnesota', cheapestRent: 198, cheapestPlaceName: 'White Earth, MN', cheapestZcta: '56591' },
        { code: 'OR', name: 'Oregon', cheapestRent: null, cheapestPlaceName: null, cheapestZcta: null },
      ],
    },
    ...partial,
  } as ComposedAnswer
}

describe('gateMapModel', () => {
  it('shades bound states by their cheapest screened figure and marks the winner', () => {
    const model = gateMapModel(gateAnswer(), BASEMAP_STATES)!
    expect(model.headlineKey).toBe('median_gross_rent')
    expect(model.min).toBe(198)
    expect(model.max).toBe(235)
    const byCode = new Map(model.states.map((s) => [s.code, s]))
    expect(byCode.get('CA')?.stateClass).toBe('valued')
    expect(byCode.get('CA')?.value).toBe(225)
    expect(byCode.get('CA')?.color).toBeTruthy()
    // The winner is the state holding the set's cheapest place.
    expect(model.winnerCode).toBe('MN')
    expect(byCode.get('MN')?.isWinner).toBe(true)
    expect(model.cheapest).toEqual({ placeName: 'White Earth, MN', stateName: 'Minnesota', value: 198 })
    // A bound state with no measured row is unmeasured, never dropped.
    expect(byCode.get('OR')?.stateClass).toBe('unmeasured')
    // A state outside the classification is outside the frame.
    expect(byCode.get('KY')?.stateClass).toBe('outside')
  })

  it('marks the singled-out state as winner and the rest of the class as classified-only', () => {
    const answer = gateAnswer()
    const gate = answer.geographyGate!
    const winnerAnswer = gateAnswer({
      geographyGate: {
        ...gate,
        winnerState: { code: 'CO', name: 'Colorado' },
        boundStates: [{ code: 'CO', name: 'Colorado' }],
        standings: gate.standings.filter((s) => s.code === 'CO'),
      },
    })
    const model = gateMapModel(winnerAnswer, BASEMAP_STATES)!
    expect(model.winnerCode).toBe('CO')
    const byCode = new Map(model.states.map((s) => [s.code, s]))
    expect(byCode.get('CO')?.stateClass).toBe('valued')
    expect(byCode.get('CA')?.stateClass).toBe('classified')
    expect(byCode.get('IL')?.stateClass).toBe('classified')
  })

  it('returns null without a gate record', () => {
    const plain = gateAnswer()
    delete (plain as { geographyGate?: unknown }).geographyGate
    expect(gateMapModel(plain, BASEMAP_STATES)).toBeNull()
  })
})

describe('gate map suppression', () => {
  it('the result choropleth never mounts for a gate answer', () => {
    expect(resultMapRelevant(gateAnswer())).toBe(false)
  })

  it('speech names the gate map by its actual content', () => {
    const kinds = terminalChartKinds(gateAnswer())
    expect(kinds).toHaveLength(1)
    expect(kinds[0]?.sentence).toContain('qualifying states shaded by their cheapest screened median gross rent')
  })

  it('a plain screen answer keeps its choropleth', () => {
    const plain = gateAnswer()
    delete (plain as { geographyGate?: unknown }).geographyGate
    expect(resultMapRelevant(plain)).toBe(true)
  })
})
