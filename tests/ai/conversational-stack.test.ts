import { beforeEach, describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import {
  JEV_BRANCH_THRESHOLD,
  JEV_CRITERION_NOUL_THRESHOLD,
  JEV_PHRASE_THRESHOLD,
  JEV_SCORE_THRESHOLD,
  branchQuestions,
  loopQuestions,
  phraseQuestions,
  type JevAnswer,
  type JevTransport,
} from '../../src/core/ai/jev-judgments'
import { bestVersionIndex, runJevLoop, type JevLoopState } from '../../src/core/ai/jev-loop'
import {
  buildPlanPacket,
  buildVerifyPacket,
  estimateTokens,
  parsePlanVerdict,
  parseVerifyVerdict,
  wonderLabelFor,
  PLAN_PACKET_TOKEN_BUDGET,
  VERIFY_PACKET_TOKEN_BUDGET,
} from '../../src/core/ai/bookends'
import {
  applicableModes,
  blendEvidenceText,
  proximityFocus,
} from '../../src/core/ai/nearby'
import {
  canPropose,
  canRefine,
  decisionsFromSearch,
  dismissModal,
  expireModalForNewQuestion,
  initialModalState,
  landModal,
  markRefined,
  parseDecisions,
  phraseBranchQuestion,
  proposeModal,
  readSessionDecisions,
  refinementNote,
  resetSessionDecisionsForTests,
  serializeDecisions,
  subjectForCriterion,
  withDecisionsParam,
  writeSessionDecision,
  type DecisionsStorage,
} from '../../src/core/ai/decision-branches'
import {
  composeAnswerForRequest,
  evaluateDecisionProposal,
  refineAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { ACK_OPENERS, pickAckOpener, researchAck } from '../../src/ui/ai/ack'

/**
 * The conversational stack's hermetic pins (plan C12): the Jev loop,
 * the bookend ordering + labeling, the modal state machine, the
 * specificity rule, and the nearby blend — all over scripted
 * transports and the stub provider. No network, no live model.
 */

const ROWS: AreaRow[] = [
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
  { zcta: '96749', name: 'Keaau, HI', metrics: { median_gross_rent: 1325 }, moes: { median_gross_rent: 120 } },
  { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1750 }, moes: { median_gross_rent: 150 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
    clarificationNeeded: false,
    ...partial,
  }
}

const NO_JEV: JevTransport = async () => {
  throw new Error('jev route: HTTP 500')
}
const NO_BOOKENDS = { planTransport: async () => null, verifyTransport: async () => null }

/** A loop-set reply builder: every criterion at `noul`, scores at `score`. */
function loopAnswers(noul: number, score = 2): Record<string, JevAnswer> {
  return {
    'criterion:median_gross_rent': { type: 'noul', probability: noul },
    'criterion:schools': { type: 'noul', probability: noul },
    'criterion:coffee': { type: 'noul', probability: noul },
    relevance: { type: 'score', expected: score, distribution: { '0': 0, '1': 0, '2': 1 } },
    completeness: { type: 'score', expected: score, distribution: { '0': 0, '1': 0, '2': 1 } },
  }
}

/* ------------------------------------------------------------------ */
/* Judgment-set definitions (plan C3)                                  */
/* ------------------------------------------------------------------ */

describe('jev judgment sets', () => {
  it('thresholds are the plan constants', () => {
    expect(JEV_CRITERION_NOUL_THRESHOLD).toBe(0.8)
    expect(JEV_SCORE_THRESHOLD).toBe(1.5)
    expect(JEV_BRANCH_THRESHOLD).toBe(0.75)
    expect(JEV_PHRASE_THRESHOLD).toBe(0.8)
  })

  it('J-LOOP carries one Noul per criterion plus the two Scores', () => {
    const questions = loopQuestions([
      { id: 'schools', text: 'School quality' },
      { id: 'coffee', text: 'Coffee nearby' },
    ])
    expect(questions.filter((q) => q.type === 'noul')).toHaveLength(2)
    expect(questions.find((q) => q.id === 'criterion:schools')?.instructions).toContain(
      'Criterion School quality is addressed in the answer with evidence',
    )
    expect(questions.filter((q) => q.type === 'score').map((q) => q.id)).toEqual([
      'relevance',
      'completeness',
    ])
  })

  it('J-BRANCH names the catalogued branches in its Choice; J-PHRASE is one Noul', () => {
    const branch = branchQuestions()
    expect(branch.find((q) => q.type === 'choice')?.criteria).toEqual([
      'transport',
      'school-level',
      'budget-anchor',
      'none-of-these',
    ])
    expect(phraseQuestions()).toHaveLength(1)
    expect(phraseQuestions()[0]?.type).toBe('noul')
  })
})

/* ------------------------------------------------------------------ */
/* C4 — the Jev loop                                                   */
/* ------------------------------------------------------------------ */

describe('jev loop', () => {
  const deps = (overrides: Partial<Parameters<typeof runJevLoop<string>>[1]>) => ({
    transport: (async () => ({ answers: loopAnswers(0.95) })) as JevTransport,
    criteria: [
      { id: 'median_gross_rent', text: 'median_gross_rent' },
      { id: 'schools', text: 'School quality' },
    ],
    evidenceLabels: [],
    sourceCount: 1,
    textOf: (a: string) => a,
    verifyOf: () => true,
    patch: async () => null,
    ...overrides,
  })

  it('passes on the first evaluation: no patch, roundsUsed 0', async () => {
    let patches = 0
    const outcome = await runJevLoop(
      'answer v1',
      deps({
        patch: async () => {
          patches += 1
          return 'answer v2'
        },
      }),
    )
    expect(outcome.ran).toBe(true)
    expect(outcome.answer).toBe('answer v1')
    expect(outcome.state.roundsUsed).toBe(0)
    expect(patches).toBe(0)
  })

  it('patches once on a named gap, with the gap verbatim, and ships the better version', async () => {
    let evaluations = 0
    let patchRequest: { answerText: string; gaps: string[]; instruction: string } | null = null
    const outcome = await runJevLoop(
      'answer v1',
      deps({
        transport: async () => {
          evaluations += 1
          return { answers: loopAnswers(evaluations === 1 ? 0.4 : 0.95) }
        },
        patch: async (request) => {
          patchRequest = request
          return 'answer v2'
        },
      }),
    )
    expect(patchRequest!.instruction).toBe('patch-only')
    expect(patchRequest!.gaps).toContain('Criterion School quality is not addressed with evidence')
    expect(outcome.answer).toBe('answer v2')
    expect(outcome.state.roundsUsed).toBe(1)
    expect(outcome.state.versions).toHaveLength(2)
  })

  it('caps at 2 rounds and ships the best grounded version', async () => {
    const outcome = await runJevLoop(
      'v1',
      deps({
        transport: async () => ({ answers: loopAnswers(0.4) }),
        patch: async ({ answerText }) => `${answerText}+`,
      }),
    )
    expect(outcome.state.roundsUsed).toBe(2)
    expect(outcome.state.versions).toHaveLength(3)
  })

  it('discards a patch that fails verify — the prior grounded version stands', async () => {
    const outcome = await runJevLoop(
      'grounded',
      deps({
        transport: async () => ({ answers: loopAnswers(0.4) }),
        verifyOf: (candidate: string) => candidate === 'grounded',
        patch: async () => 'patched-but-broken-figure',
      }),
    )
    expect(outcome.answer).toBe('grounded')
    expect(outcome.state.versions).toHaveLength(1)
  })

  it('transport failure skips the loop: the answer ships, ran is false', async () => {
    const outcome = await runJevLoop('answer', deps({ transport: NO_JEV }))
    expect(outcome.ran).toBe(false)
    expect(outcome.answer).toBe('answer')
  })

  it('best-version selection is a pure function over the loop state shape', () => {
    const state: JevLoopState<string> = {
      roundsUsed: 2,
      versions: [
        { answer: 'a', text: 'a', verify: 'pass', noul: { x: 0.9, y: 0.3 }, relevance: 2, completeness: 2 },
        { answer: 'b', text: 'b', verify: 'pass', noul: { x: 0.9, y: 0.9 }, relevance: 1.6, completeness: 1.6 },
        { answer: 'c', text: 'c', verify: 'pass', noul: { x: 0.9, y: 0.9 }, relevance: 1.6, completeness: 1.6 },
      ],
    }
    // b beats a on passing Nouls; c ties b exactly and does not displace it.
    expect(bestVersionIndex(state)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* Bookends (plan C2/C5)                                               */
/* ------------------------------------------------------------------ */

describe('bookend verdicts and packets', () => {
  it('parses the annex schemas exactly; off-schema is a degradation (null)', () => {
    expect(parsePlanVerdict({ verdict: 'sound' })).toEqual({ verdict: 'sound', objections: [] })
    expect(
      parsePlanVerdict({
        verdict: 'unsound',
        objections: [{ code: 'missing_criterion', detail: 'schools missing' }],
      })?.verdict,
    ).toBe('unsound')
    expect(parsePlanVerdict({ verdict: 'unsound', objections: [{ code: 'other', detail: 'x' }] })).toBeNull()
    expect(parsePlanVerdict({ verdict: 'maybe' })).toBeNull()
    expect(parseVerifyVerdict({ verdict: 'verified' })?.verdict).toBe('verified')
    expect(
      parseVerifyVerdict({
        verdict: 'concerns',
        concerns: [{ kind: 'presentational', detail: 'ordering' }],
      })?.verdict,
    ).toBe('concerns')
    expect(parseVerifyVerdict({ verdict: 'concerns', concerns: [{ kind: 'x', detail: 'y' }] })).toBeNull()
  })

  it('labels Wonder only for verified/concerns — never for not-run shapes', () => {
    expect(wonderLabelFor({ verdict: 'verified', concerns: [] })).toBe('verified')
    expect(
      wonderLabelFor({ verdict: 'concerns', concerns: [{ kind: 'factual', detail: 'x' }] }),
    ).toBe('concerns')
    expect(
      wonderLabelFor({ verdict: 'not_verified', concerns: [{ kind: 'factual', detail: 'x' }] }),
    ).toBe('not-run')
    expect(wonderLabelFor(null)).toBe('not-run')
  })

  it('packet builders respect their token budgets under trim', () => {
    const plan = buildPlanPacket({
      question: 'q '.repeat(200),
      intent: { mode: 'sweep_filter', geographies: ['Hilo'], metricKeys: ['median_gross_rent'] },
      criteria: Array.from({ length: 60 }, (_, i) => ({
        kind: 'research' as const,
        text: `criterion ${i} ${'x'.repeat(80)}`,
      })),
      subsetSummary: { count: 3, ranges: [{ key: 'median_gross_rent', min: 1, max: 2 }] },
      decisions: {},
    })
    expect(estimateTokens(JSON.stringify(plan))).toBeLessThanOrEqual(PLAN_PACKET_TOKEN_BUDGET)
    const verify = buildVerifyPacket({
      summary: 's'.repeat(4000),
      places: Array.from({ length: 30 }, (_, i) => ({
        name: `Place ${i}`,
        figures: [{ key: 'median_gross_rent', value: 1000 }],
      })),
      evidence: Array.from({ length: 20 }, (_, i) => ({
        criterion: `c${i}`,
        status: 'met',
        detail: 'd'.repeat(200),
      })),
      sources: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://e.org/${i}` })),
      verifySummary: 'ok',
      placeDisplayLimit: 10,
    })
    expect(estimateTokens(JSON.stringify(verify))).toBeLessThanOrEqual(VERIFY_PACKET_TOKEN_BUDGET)
    // Places beyond the display limit compress to the shown names
    // (plan C5): the wire packet carries the first placeDisplayLimit
    // place names, and the total count reaches the bookend in the
    // caller's verifySummary, which both runners build with the
    // full place count (route-contract cure 2026-11-03: the old
    // packet's additionalPlaces field had no counterpart in the
    // verify route's contract).
    expect(verify.places).toHaveLength(10)
    expect(verify.places[0]).toBe('Place 0')
  })
})

/* ------------------------------------------------------------------ */
/* C8 — specificity                                                    */
/* ------------------------------------------------------------------ */

describe('specificity rule', () => {
  it('pins the Starbucks form from the owner template, verbatim', () => {
    const subject = subjectForCriterion('coffee', 'best schools and a Starbucks nearby')
    expect(subject).toBe('these nearby Starbucks')
    expect(phraseBranchQuestion('transport', 'a Starbucks nearby', 'Coffee nearby', subject)).toBe(
      'Quick question — would you be using a car to get to these nearby Starbucks?',
    )
  })

  it('a generic phrasing is not what the function produces', () => {
    const drafted = phraseBranchQuestion(
      'transport',
      'coffee nearby',
      'Coffee nearby',
      subjectForCriterion('coffee', 'coffee nearby'),
    )
    expect(drafted).not.toBe('Do you have a car?')
    expect(drafted).toContain('coffee shops near these places')
  })
})

/* ------------------------------------------------------------------ */
/* C7 — modal state machine + decision state                           */
/* ------------------------------------------------------------------ */

describe('modal state machine', () => {
  it('one at a time; land/dismiss/expire close the branch; refine-once', () => {
    let state = initialModalState()
    expect(canPropose(state, 'transport', {})).toBe(true)
    state = proposeModal(state, { branch: 'transport', questionText: 'q', runId: 1 }, {})
    expect(state.live?.branch).toBe('transport')
    // A second proposal while one is live is suppressed.
    expect(canPropose(state, 'school-level', {})).toBe(false)
    state = dismissModal(state)
    expect(state.live).toBeNull()
    // Dismissed branch is closed for the session (not re-shown).
    expect(canPropose(state, 'transport', {})).toBe(false)

    let landed = proposeModal(initialModalState(), { branch: 'transport', questionText: 'q', runId: 1 }, {})
    landed = landModal(landed)
    expect(landed.live).toBeNull()
    // A decision in state is never re-asked.
    expect(canPropose(landed, 'transport', { transport: 'no-car' })).toBe(false)

    let expiring = proposeModal(initialModalState(), { branch: 'school-level', questionText: 'q', runId: 1 }, {})
    expiring = expireModalForNewQuestion(expiring)
    expect(expiring.live).toBeNull()
    expect(canPropose(expiring, 'school-level', {})).toBe(false)

    expect(canRefine(initialModalState(), 'transport')).toBe(true)
    const refined = markRefined(initialModalState(), 'transport')
    expect(canRefine(refined, 'transport')).toBe(false)
  })

  it('decisions round-trip through URL and session state', () => {
    expect(serializeDecisions({ transport: 'no-car' })).toBe('transport=no-car')
    expect(parseDecisions('transport=no-car,bogus=x,school-level=high')).toEqual({
      transport: 'no-car',
      'school-level': 'high',
    })
    const search = withDecisionsParam('intent=abc', { transport: 'car' })
    expect(decisionsFromSearch(search)).toEqual({ transport: 'car' })
    expect(search).toContain('intent=abc')
  })

  it('session decisions persist through the storage seam', () => {
    resetSessionDecisionsForTests()
    const memory = new Map<string, string>()
    const storage: DecisionsStorage = {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
    }
    writeSessionDecision('transport', 'no-car', storage)
    expect(readSessionDecisions(storage)).toEqual({ transport: 'no-car' })
    resetSessionDecisionsForTests()
  })

  it('refinement notes state what changed', () => {
    expect(refinementNote('transport', 'no-car')).toBe(
      'Refined with your answer: no car — walking, biking, or a short public transit ride counted as near.',
    )
  })
})

/* ------------------------------------------------------------------ */
/* C9 — nearby blend                                                   */
/* ------------------------------------------------------------------ */

describe('nearby blend', () => {
  it('applicability: car / no-car / unanswered three-way', () => {
    expect(applicableModes('car')).toEqual(['walking', 'bicycling', 'transit', 'driving'])
    expect(applicableModes('no-car')).toEqual(['walking', 'bicycling', 'transit'])
    expect(applicableModes(undefined)).toEqual(['walking', 'bicycling', 'transit', 'driving'])
  })

  it('the blend template carries the mode basis inside the evidence', () => {
    const text = blendEvidenceText({
      modes: applicableModes(undefined),
      findings: [
        { mode: 'driving', text: '2 within a short drive' },
        { mode: 'walking', text: '0 within walking distance' },
      ],
    })
    expect(text).toBe(
      'Counted as near if reachable by walking, biking, a short public transit ride, or a short drive; ' +
        'across those modes, 2 within a short drive; 0 within walking distance. ' +
        '(Mode basis: walking, biking, a short public transit ride, or a short drive.)',
    )
  })

  it('the research focus carries the applicable mode set + radii', () => {
    const focus = proximityFocus('coffee', 'no-car')
    expect(focus.modes).toEqual(['walking', 'bicycling', 'transit'])
    expect(focus.focusText).toContain('about 1 mile')
    expect(focus.focusText).toContain('about 3 miles')
    expect(focus.focusText).not.toContain('10 minute drive')
    expect(proximityFocus('coffee', undefined).focusText).toContain('about a 10 minute drive')
  })
})

/* ------------------------------------------------------------------ */
/* C6 — ack frame                                                      */
/* ------------------------------------------------------------------ */

describe('ack frame', () => {
  it('uses the annex opener set and never repeats back-to-back', () => {
    for (const question of ['a', 'bb', 'ccc', 'dddd', 'cheapest place to live']) {
      const opener = pickAckOpener(question)
      expect(ACK_OPENERS).toContain(opener)
      expect(pickAckOpener(question, opener)).not.toBe(opener)
    }
    expect(researchAck('School quality')).toBe(
      'On it — checking the Census figures and looking into school quality.',
    )
  })
})

/* ------------------------------------------------------------------ */
/* Runner integration: loop, bookends, branch, blend, degradation      */
/* ------------------------------------------------------------------ */

describe('runner conversational stack', () => {
  const starbucksQuery = 'places with a Starbucks nearby where rent is under $1,500'
  const starbucksProvider = () =>
    createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI has a Starbucks nearby. Keaau, HI has a Starbucks nearby.',
          sources: [{ title: 'Store locator', url: 'https://example.org/stores' }],
        }
      },
    })

  it('degradation: Jev 500 ships the answer clean, with no Jev or Wonder claim', async () => {
    const answer = await composeAnswerForRequest({
      intent: intent({}),
      queryText: starbucksQuery,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider: starbucksProvider(),
      research: true,
      stack: { jevTransport: NO_JEV, ...NO_BOOKENDS, decisions: {} },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.verification?.jev).toBe('not-run')
    expect(answer?.verification?.wonder).toBe('not-run')
    expect(answer?.decisionProposal).toBeUndefined()
    expect(answer?.timings?.pipeline).toBeGreaterThanOrEqual(0)
  })

  it('bookend ordering: plan before research, verify after the loop; labels land', async () => {
    const order: string[] = []
    const provider = createStubProvider({
      async research() {
        order.push('research')
        return {
          prose: 'Hilo, HI has a Starbucks nearby.',
          sources: [{ title: 'Store locator', url: 'https://example.org/stores' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent({}),
      queryText: starbucksQuery,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider,
      research: true,
      stack: {
        decisions: {},
        jevTransport: async ({ set }) => {
          order.push(`jev:${set}`)
          if (set === 'J-LOOP') return { answers: loopAnswers(0.95) }
          return {
            answers: {
              'branch-exists': { type: 'noul', probability: 0.1 },
              'branch-which': { type: 'choice', selected: 'none-of-these', distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 } },
            } as Record<string, JevAnswer>,
          }
        },
        planTransport: async () => {
          order.push('plan')
          return { verdict: 'sound', objections: [] }
        },
        verifyTransport: async () => {
          order.push('verify')
          return { verdict: 'verified', concerns: [] }
        },
      },
    })
    expect(answer?.status).toBe('verified')
    expect(order.indexOf('plan')).toBeLessThan(order.indexOf('research'))
    expect(order.indexOf('verify')).toBeGreaterThan(order.indexOf('jev:loop'))
    expect(answer?.verification?.wonder).toBe('verified')
    expect(answer?.verification?.jev).toEqual({ roundsUsed: 0, passed: true })
    expect(typeof answer?.timings?.plan).toBe('number')
    expect(typeof answer?.timings?.verify).toBe('number')
    expect(typeof answer?.timings?.['jev-round-0']).toBe('number')
  })

  it('loop patch at the runner: a gap-named re-research ships the better grounded version', async () => {
    let researchCalls = 0
    let loopCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls += 1
        return researchCalls === 1
          ? {
              prose: 'Hilo, HI is a place in Hawaii.',
              sources: [{ title: 'Gazetteer', url: 'https://example.org/gaz' }],
            }
          : {
              prose: 'Hilo, HI schools are rated above the state average in the cited directory.',
              sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
            }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: intent({}),
      queryText: 'places with the best schools where rent is under $1,500',
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider,
      research: true,
      stack: {
        decisions: {},
        ...NO_BOOKENDS,
        jevTransport: async ({ set }) => {
          if (set === 'J-BRANCH') {
            return {
              answers: {
                'branch-exists': { type: 'noul', probability: 0.1 },
                'branch-which': { type: 'choice', selected: 'none-of-these', distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 } },
              } as Record<string, JevAnswer>,
            }
          }
          loopCalls += 1
          return { answers: loopAnswers(loopCalls === 1 ? 0.3 : 0.95) }
        },
      },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.verification?.jev).toEqual({ roundsUsed: 1, passed: true })
    expect(researchCalls).toBeGreaterThan(1)
    // The shipped version is the patched one: its schools claim is on the card.
    expect(answer?.criterionEvidence.find((e) => e.criterion === 'School quality')?.status).toBe('met')
  })

  it('branch boundary: fires at 0.75 with the specific Starbucks phrasing; not at 0.74', async () => {
    const transportFor = (fire: number): JevTransport =>
      async ({ set, state }) => {
        if (set === 'J-BRANCH') {
          return {
            answers: {
              'branch-exists': { type: 'noul', probability: fire },
              'branch-which': { type: 'choice', selected: 'transport', distribution: { transport: 0.9, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 0.1 } },
            } as Record<string, JevAnswer>,
          }
        }
        // J-PHRASE fixture: a drafted question naming the actual subject
        // passes; a generic one ("Do you have a car?") is rejected.
        const drafted = String(state.draftedQuestion ?? '')
        return {
          answers: {
            'phrase-specific': {
              type: 'noul',
              probability: drafted.includes('Starbucks') ? 0.9 : 0.2,
            },
          } as Record<string, JevAnswer>,
        }
      }
    const fired = await evaluateDecisionProposal({
      queryText: 'best schools and a Starbucks nearby',
      intent: intent({ filters: [], metricKeys: [] }),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: transportFor(JEV_BRANCH_THRESHOLD),
    })
    expect(fired?.questionText).toBe(
      'Quick question — would you be using a car to get to these nearby Starbucks?',
    )
    const notFired = await evaluateDecisionProposal({
      queryText: 'best schools and a Starbucks nearby',
      intent: intent({ filters: [], metricKeys: [] }),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: transportFor(0.74),
    })
    expect(notFired).toBeUndefined()
    // A landed decision is never re-asked.
    const decided = await evaluateDecisionProposal({
      queryText: 'best schools and a Starbucks nearby',
      intent: intent({ filters: [], metricKeys: [] }),
      research: true,
      decisions: { transport: 'no-car' },
      closedBranches: new Set(),
      jevTransport: transportFor(0.99),
    })
    expect(decided).toBeUndefined()
  })

  it('phrase gate: one rephrase attempt, then interjection closes', async () => {
    let phraseCalls = 0
    const proposal = await evaluateDecisionProposal({
      queryText: 'coffee shops nearby please',
      intent: intent({ filters: [], metricKeys: [] }),
      research: true,
      decisions: {},
      closedBranches: new Set(),
      jevTransport: async ({ set }) => {
        if (set === 'J-BRANCH') {
          return {
            answers: {
              'branch-exists': { type: 'noul', probability: 0.9 },
              'branch-which': { type: 'choice', selected: 'transport', distribution: { transport: 1, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 0 } },
            } as Record<string, JevAnswer>,
          }
        }
        phraseCalls += 1
        // First draft scores generic; the rephrase (criterion named) passes.
        return {
          answers: {
            'phrase-specific': { type: 'noul', probability: phraseCalls === 1 ? 0.3 : 0.9 },
          } as Record<string, JevAnswer>,
        }
      },
    })
    expect(phraseCalls).toBe(2)
    expect(proposal?.questionText).toContain('coffee nearby')
  })

  it('blend wording lands in the proximity evidence for car / no-car / unanswered', async () => {
    for (const decisions of [{}, { transport: 'car' }, { transport: 'no-car' }] as const) {
      const answer = await composeAnswerForRequest({
        intent: intent({}),
        queryText: starbucksQuery,
        rows: ROWS,
        resolved: resolveAnswerGeographies(intent({}), null),
        provider: starbucksProvider(),
        research: true,
        stack: { jevTransport: NO_JEV, ...NO_BOOKENDS, decisions },
      })
      const evidence = answer?.criterionEvidence.find((e) => e.criterion === 'Coffee nearby')
      expect(evidence?.detail).toContain('(Mode basis:')
      if (decisions.transport === 'no-car') {
        expect(evidence?.detail).not.toContain('short drive')
      } else {
        expect(evidence?.detail).toContain('short drive')
      }
    }
  })

  it('refinement: a landed decision re-runs, replaces in place with the note; provisional kept on failure', async () => {
    resetSessionDecisionsForTests()
    const provisional = await composeAnswerForRequest({
      intent: intent({}),
      queryText: starbucksQuery,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider: starbucksProvider(),
      research: true,
      stack: { jevTransport: NO_JEV, ...NO_BOOKENDS, decisions: {} },
    })
    expect(provisional).not.toBeNull()
    const refined = await refineAnswerForRequest({
      intent: intent({}),
      queryText: starbucksQuery,
      rows: ROWS,
      resolved: resolveAnswerGeographies(intent({}), null),
      provider: starbucksProvider(),
      research: true,
      placeIndex: null,
      provisional: provisional!,
      branch: 'transport',
      option: 'no-car',
      stack: { jevTransport: NO_JEV, ...NO_BOOKENDS, decisions: {} },
    })
    expect(refined.refinementNote).toContain('no car')
    expect(refined.criterionEvidence.find((e) => e.criterion === 'Coffee nearby')?.detail).not.toContain(
      'short drive',
    )
    expect(readSessionDecisions()).toEqual({ transport: 'no-car' })
    resetSessionDecisionsForTests()
  })
})

beforeEach(() => {
  resetSessionDecisionsForTests()
})
