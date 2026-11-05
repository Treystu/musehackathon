import { describe, expect, it } from 'vitest'
import {
  branchDefinition,
  decisionEffect,
  refinementNote,
} from '../../src/core/ai/decision-branches'
import { decomposeResearchCriteria } from '../../src/core/ai/answer'
import { hasStatedRadius } from '../../src/core/ai/near-frame'
import type { NearFrameContext } from '../../src/core/ai/near-frame'
import {
  applyDecidedDistance,
  evaluateDecisionProposal,
  unstatedDistanceProposal,
} from '../../src/ui/ai/answer-runner'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import type { JevTransport } from '../../src/core/ai/jev-judgments'

/**
 * H4 — W2 uncatalogued criteria + bare-near distance (Hail-Mary).
 * The follow-up class's sole criterion (the combined carry) is
 * claimed by the generic proximity-distance branch, so the modal
 * can fire for it; a bare 'near <place>' proposes a distance for
 * confirmation instead of defaulting silently; a stated distance
 * is used as stated.
 */

function sweepIntent(over: Partial<ValidatedIntent> = {}): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: ['Colorado'],
    metricKeys: ['median_gross_rent'],
    filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
    clarificationNeeded: false,
    ...over,
  }
}

/** Jev stub selecting the proximity-distance branch with a passing phrase. */
function proximityJev(): JevTransport {
  return async ({ set }) => {
    if (set === 'J-BRANCH') {
      return {
        answers: {
          'branch-exists': { type: 'noul', probability: 0.9 },
          'branch-which': {
            type: 'choice',
            selected: 'proximity-distance',
            distribution: { 'proximity-distance': 0.9, 'none-of-these': 0.1 },
          },
        },
      } as never
    }
    return { answers: { 'phrase-specific': { type: 'noul', probability: 0.9 } } } as never
  }
}

/** Jev stub that never fires (proves the deterministic path needs no transport). */
function silentJev(): JevTransport {
  return async () => {
    throw new Error('no transport')
  }
}

function bareNearFrame(): NearFrameContext {
  return {
    anchorLabel: 'Denver, CO',
    anchorName: 'Denver',
    anchorZctas: new Set(['80202']),
    anchorZipCount: 1,
    candidateZctas: new Set(['80203']),
    candidatePrefixes: ['802'],
    candidateCount: 1,
    radiusMiles: 25,
    radiusStated: false,
    relativeCost: false,
    baseline: null,
  }
}

describe('H4 uncatalogued criteria reach the modal', () => {
  it('a Walmart follow-up decomposes to the uncatalogued combined criterion', () => {
    const criteria = decomposeResearchCriteria('also needs to be near a Walmart')
    expect(criteria.length).toBeGreaterThan(0)
    expect(criteria.every((c) => c.id === 'combined')).toBe(true)
  })

  it('the generic proximity branch claims combined, with distance options', () => {
    const definition = branchDefinition('proximity-distance')
    expect(definition?.criterionIds).toContain('combined')
    expect(definition?.options.map((o) => o.id)).toEqual(['5', '10', '25'])
  })

  it('the combined specimen reaches the modal via the catalog fix', async () => {
    const proposal = await evaluateDecisionProposal({
      queryText: 'also needs to be near a Walmart',
      intent: sweepIntent(),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: proximityJev(),
    })
    expect(proposal?.branch).toBe('proximity-distance')
    expect(proposal?.criterionId).toBe('combined')
    expect(proposal?.questionText).toContain('what distance should count as near')
    expect(proposal?.options.map((o) => o.id)).toEqual(['5', '10', '25'])
  })

  it('a stated distance suppresses the catalog path too', async () => {
    expect(hasStatedRadius('also needs to be near a Walmart (within 10 miles)')).toBe(true)
    const proposal = await evaluateDecisionProposal({
      queryText: 'also needs to be near a Walmart (within 10 miles)',
      intent: sweepIntent(),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: proximityJev(),
    })
    expect(proposal).toBeUndefined()
  })
})

describe('H4 bare-near proposes rather than defaults', () => {
  it('unstated default proposes distances deterministically, no transport', () => {
    const proposal = unstatedDistanceProposal({
      queryText: 'What suburbs near Denver have good schools?',
      nearFrame: bareNearFrame(),
      decisions: {},
      closedBranches: new Set(),
    })
    expect(proposal?.branch).toBe('proximity-distance')
    expect(proposal?.questionText).toContain('Denver')
    expect(proposal?.questionText).toContain('what distance should count as near')
    expect(proposal?.options.map((o) => o.id)).toEqual(['5', '10', '25'])
    expect(proposal?.dismissLabel).toBe('Keep the 25-mile reading')
  })

  it('stated radius never proposes; decided and closed never re-propose', () => {
    const stated = { ...bareNearFrame(), radiusStated: true, radiusMiles: 10 }
    expect(
      unstatedDistanceProposal({
        queryText: 'What is cheapest within 10 miles of Denver?',
        nearFrame: stated,
        decisions: {},
        closedBranches: new Set(),
      }),
    ).toBeUndefined()
    expect(
      unstatedDistanceProposal({
        queryText: 'What suburbs near Denver have good schools?',
        nearFrame: bareNearFrame(),
        decisions: {},
        closedBranches: new Set(['proximity-distance']),
      }),
    ).toBeUndefined()
    expect(
      unstatedDistanceProposal({
        queryText: 'What suburbs near Denver have good schools?',
        nearFrame: bareNearFrame(),
        decisions: { 'proximity-distance': '10' },
        closedBranches: new Set(),
      }),
    ).toBeUndefined()
    expect(
      unstatedDistanceProposal({
        queryText: 'What suburbs near Denver have good schools?',
        nearFrame: null,
        decisions: {},
        closedBranches: new Set(),
      }),
    ).toBeUndefined()
  })

  it('the Jev path is silent without a transport; the deterministic path still fires', async () => {
    const viaJev = await evaluateDecisionProposal({
      queryText: 'What suburbs near Denver have good schools?',
      intent: sweepIntent({ geographies: ['Denver, CO'] }),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: silentJev(),
    })
    expect(viaJev).toBeUndefined()
  })
})

describe('H4 landed distance takes effect', () => {
  it('a confirmed distance replaces the silent default and reads as stated', () => {
    const bare = { radiusMiles: 25, radiusStated: false }
    const decided = applyDecidedDistance(bare, { 'proximity-distance': '10' })
    expect(decided.radiusMiles).toBe(10)
    expect(decided.radiusStated).toBe(true)
  })

  it('stated radii and undecided questions pass through untouched', () => {
    expect(applyDecidedDistance({ radiusMiles: 10, radiusStated: true }, { 'proximity-distance': '5' })).toEqual({
      radiusMiles: 10,
      radiusStated: true,
    })
    expect(applyDecidedDistance({ radiusMiles: 25, radiusStated: false }, {})).toEqual({
      radiusMiles: 25,
      radiusStated: false,
    })
  })

  it('effect and note name the confirmed distance', () => {
    expect(decisionEffect('proximity-distance', '10').focusText).toContain('within 10 miles')
    expect(refinementNote('proximity-distance', '10')).toContain('within 10 miles')
  })
})
