import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  decomposeResearchCriteria,
  extractBareCandidateNames,
  filterWorkingNarration,
  researchPerCriterion,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import {
  buildFlexiblePacketText,
  parseFlexibleDraft,
  verifyFlexibleAnswer,
  type FlexibleAnswer,
} from '../../src/core/ai/flexible'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import type { JevAnswer, JevTransport } from '../../src/core/ai/jev-judgments'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'

/**
 * The flexible completion lane's hermetic pins (2026-11-02, owner
 * directive; Jev gate PROCEED-with-note with structural safeguards).
 *
 * The lane completes exactly one strict terminal: research-first
 * research mismatch — research succeeded and named places, none
 * matched Census data, and the strict answer is the bare
 * not-matched note (the owner's schools + fast-food question, live
 * twice on 2026-11-02). Everything else keeps its terminal:
 * provider failures throw, safety refusals stay blocked, a genuine
 * Census screen with no match stays a data answer, and a strict
 * card is never touched.
 *
 * The honesty pins are the gate's condition: a completion renders
 * only through the typed shape, every place and figure carries an
 * evidence class, and the extended validator rejects an unlabeled
 * figure or a Census claim with no screened row behind it — so a
 * rejected completion leaves the strict note standing, fail-closed.
 */

const ROWS: AreaRow[] = [
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
  { zcta: '96749', name: 'Keaau, HI', metrics: { median_gross_rent: 1325 }, moes: { median_gross_rent: 120 } },
  { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1750 }, moes: { median_gross_rent: 150 } },
]

const SENTENCE_1 = 'Where can I find the best schools but also the fewest fast food restaurants?'
const NOT_MATCHED_NOTE =
  'Research for the stated criteria did not produce a place that could be shown here.'

const EXTERNAL_ONLY: ValidatedIntent = {
  mode: 'lookup',
  geographies: [],
  metricKeys: [],
  filters: [],
  clarificationNeeded: true,
}

const UNMATCHED_RESEARCH = {
  prose:
    'Stone Mountain, GA schools are rated above the state average in the cited directory. ' +
    'Kingwood, TX has few fast-food outlets along its main roads.',
  sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
}

const DRAFT = {
  prose:
    'Stone Mountain, GA and Kingwood, TX are the places the cited research named for the ' +
    'stated criteria. The research describes Stone Mountain schools as rated above the ' +
    'state average, and Kingwood as having few fast-food outlets along its main roads.',
  places: [
    {
      name: 'Stone Mountain, GA',
      basis: 'research',
      note: 'Named by the cited research for school quality.',
      figures: [],
    },
    {
      name: 'Kingwood, TX',
      basis: 'research',
      note: 'Named by the cited research for few fast-food outlets.',
      figures: [
        { label: 'Fast-food outlets named in the findings', value: 6, basis: 'research' },
      ],
    },
  ],
  figures: [
    {
      label: 'Share of Kingwood outlets that are fast food',
      value: 40,
      unit: '%',
      basis: 'model',
      working: '6 fast-food outlets of 15 food outlets the directory lists for the area: 6 / 15 = 40%.',
    },
  ],
}

/** A J-LOOP reply builder over whatever criteria the loop state carries. */
function loopAnswersFromState(
  state: Record<string, unknown>,
  noul: number,
): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {
    relevance: { type: 'score', expected: 2, distribution: { '0': 0, '1': 0, '2': 1 } },
    completeness: { type: 'score', expected: 2, distribution: { '0': 0, '1': 0, '2': 1 } },
  }
  const criteria = (state.criteria ?? []) as { id: string }[]
  for (const criterion of criteria) {
    answers[`criterion:${criterion.id}`] = { type: 'noul', probability: noul }
  }
  return answers
}

const NO_BRANCH: Record<string, JevAnswer> = {
  'branch-exists': { type: 'noul', probability: 0.1 },
  'branch-which': {
    type: 'choice',
    selected: 'none-of-these',
    distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 },
  },
}

function jevTransportWith(loopNoul: number | ((call: number) => number)): JevTransport {
  let loopCalls = 0
  return async ({ set, state }) => {
    if (set === 'J-BRANCH') return { answers: NO_BRANCH }
    loopCalls += 1
    const noul = typeof loopNoul === 'function' ? loopNoul(loopCalls) : loopNoul
    return { answers: loopAnswersFromState(state, noul) }
  }
}

const NO_PLAN = { planTransport: async () => null }
const VERIFIED_BOOKEND = {
  verifyTransport: async () => ({ verdict: 'verified' as const, concerns: [] }),
}

/* ------------------------------------------------------------------ */
/* Parser: the closed schema                                           */
/* ------------------------------------------------------------------ */

describe('flexible draft parser', () => {
  it('maps the draft bases onto the evidence classes', () => {
    const parsed = parseFlexibleDraft(DRAFT)
    expect(parsed).not.toBeNull()
    expect(parsed!.places.map((p) => [p.name, p.evidenceClass])).toEqual([
      ['Stone Mountain, GA', 'research_named'],
      ['Kingwood, TX', 'research_named'],
    ])
    expect(parsed!.figures[0]!.evidenceClass).toBe('model_knowledge')
    expect(parsed!.figures[0]!.working).toContain('6 / 15')
  })

  it('refuses off-schema drafts whole: missing basis, census place, empty prose', () => {
    expect(
      parseFlexibleDraft({ prose: 'x', places: [], figures: [{ label: 'N', value: 1 }] }),
    ).toBeNull()
    expect(
      parseFlexibleDraft({
        prose: 'x',
        places: [{ name: 'Hilo, HI', basis: 'census', figures: [] }],
        figures: [],
      }),
    ).toBeNull()
    expect(parseFlexibleDraft({ prose: '  ', places: [], figures: [] })).toBeNull()
    expect(parseFlexibleDraft(null)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Validator extension: the structural honesty gate                    */
/* ------------------------------------------------------------------ */

describe('verifyFlexibleAnswer', () => {
  const context = { rows: ROWS, researchNamedPlaces: ['Stone Mountain, GA', 'Kingwood, TX'] }
  const valid = (): FlexibleAnswer => parseFlexibleDraft(DRAFT)!

  it('passes a fully labelled completion', () => {
    expect(verifyFlexibleAnswer(valid(), context)).toEqual({ ok: true, failures: [] })
  })

  it('rejects a figure whose evidence label was stripped', () => {
    const stripped = valid()
    delete (stripped.figures[0] as { evidenceClass?: unknown }).evidenceClass
    const verdict = verifyFlexibleAnswer(stripped, context)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toContain('without a valid evidence class')
  })

  it('rejects a census figure with no screened row behind it (wrong value)', () => {
    const answer = valid()
    answer.figures.push({
      label: 'Median gross rent',
      value: 9999,
      evidenceClass: 'census_measured',
      censusKey: 'median_gross_rent',
      zcta: '96720',
    })
    const verdict = verifyFlexibleAnswer(answer, context)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toContain('census figure mismatch')
  })

  it('rejects a census figure for a ZCTA the screen never loaded, and one with no key', () => {
    const unknownZcta = valid()
    unknownZcta.figures.push({
      label: 'Median gross rent',
      value: 1450,
      evidenceClass: 'census_measured',
      censusKey: 'median_gross_rent',
      zcta: '60601',
    })
    expect(verifyFlexibleAnswer(unknownZcta, context).failures.join(' ')).toContain(
      'no screened row behind it',
    )
    const noKey = valid()
    noKey.figures.push({ label: 'Median gross rent', value: 1450, evidenceClass: 'census_measured' })
    expect(verifyFlexibleAnswer(noKey, context).failures.join(' ')).toContain(
      'without its metric key or ZCTA',
    )
  })

  it('accepts a census figure the screened row backs exactly, margin included', () => {
    const answer = valid()
    answer.figures.push({
      label: 'Median gross rent',
      value: 1450,
      marginOfError: 85,
      evidenceClass: 'census_measured',
      censusKey: 'median_gross_rent',
      zcta: '96720',
    })
    expect(verifyFlexibleAnswer(answer, context).ok).toBe(true)
  })

  it('rejects a place claiming research provenance the research did not name', () => {
    const answer = valid()
    answer.places.push({ name: 'Portland, OR', evidenceClass: 'research_named', figures: [] })
    const verdict = verifyFlexibleAnswer(answer, context)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toContain('research provenance')
    // The same place under the model's own label is welcome.
    answer.places[answer.places.length - 1]!.evidenceClass = 'model_knowledge'
    expect(verifyFlexibleAnswer(answer, context).ok).toBe(true)
  })

  it('research provenance survives a state-suffix difference, and only that', () => {
    // The Texas specimen (2026-11-03): the extraction record held
    // "Austin, TX"; a draft naming the place "Austin" claimed
    // research provenance and the suffix-exact comparison rejected
    // it, leaving model_knowledge as the only survivable label.
    const txContext = { rows: ROWS, researchNamedPlaces: ['Austin, TX'] }
    const bare = valid()
    bare.places = [{ name: 'Austin', evidenceClass: 'research_named', figures: [] }]
    expect(verifyFlexibleAnswer(bare, txContext).ok).toBe(true)
    // Full state name on the record side, code on the draft side:
    // the same place under its other suffix style.
    const longContext = { rows: ROWS, researchNamedPlaces: ['Austin, Texas'] }
    const coded = valid()
    coded.places = [{ name: 'Austin, TX', evidenceClass: 'research_named', figures: [] }]
    expect(verifyFlexibleAnswer(coded, longContext).ok).toBe(true)
    // A different state is a different place: the class does not
    // travel across the suffix.
    const otherState = valid()
    otherState.places = [{ name: 'Austin, MN', evidenceClass: 'research_named', figures: [] }]
    expect(verifyFlexibleAnswer(otherState, txContext).ok).toBe(false)
    // And a truncated name is not the recorded name: only a state
    // suffix is ever set aside.
    const miContext = { rows: ROWS, researchNamedPlaces: ['Traverse City, MI'] }
    const truncated = valid()
    truncated.places = [{ name: 'Traverse', evidenceClass: 'research_named', figures: [] }]
    expect(verifyFlexibleAnswer(truncated, miContext).ok).toBe(false)
  })

  it('rejects steering prose even in criteria-grounded context', () => {
    const answer = valid()
    answer.prose = 'You should move to Stone Mountain, GA for its schools.'
    const verdict = verifyFlexibleAnswer(answer, context)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toContain('banned construction')
  })
})

/* ------------------------------------------------------------------ */
/* Pipeline: the marker is the fall-through's only trigger             */
/* ------------------------------------------------------------------ */

describe('pipeline research-mismatch marker', () => {
  it('marks the research-first mismatch terminal and records every extracted name', async () => {
    const provider = createStubProvider({ research: async () => UNMATCHED_RESEARCH })
    const answer = await runAnswerPipeline({
      intent: EXTERNAL_ONLY,
      rows: ROWS,
      researchQuery: SENTENCE_1,
      queryText: SENTENCE_1,
      provider,
    })
    expect(answer.status).toBe('empty')
    expect(answer.summary).toBe(NOT_MATCHED_NOTE)
    expect(answer.noCensusMatch).toBe(true)
    expect(answer.researchNamedPlaces).toEqual(['Stone Mountain, GA', 'Kingwood, TX'])
    expect(answer.unresolvedCandidates).toEqual(['Stone Mountain, GA', 'Kingwood, TX'])
  })

  it('a genuine Census screen with no match is a data answer: no marker', async () => {
    const answer = await runAnswerPipeline({
      intent: {
        mode: 'sweep_filter',
        geographies: [],
        metricKeys: ['median_gross_rent'],
        filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 100 }],
        clarificationNeeded: false,
      },
      rows: ROWS,
    })
    expect(answer.status).toBe('empty')
    expect(answer.noCensusMatch).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* Runner: the fall-through, its gate, and its degradations            */
/* ------------------------------------------------------------------ */

describe('flexible completion at the runner', () => {
  function baseInput(flexibleTransport: (req: unknown) => Promise<unknown>, jev: JevTransport) {
    return {
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({ research: async () => UNMATCHED_RESEARCH }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jev,
        flexibleTransport: flexibleTransport as never,
      },
    }
  }

  it('sentence 1 with unmatched research places completes with labelled places', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest(
      baseInput(async () => {
        flexibleCalls += 1
        return DRAFT
      }, jevTransportWith(0.95)),
    )
    expect(flexibleCalls).toBe(1)
    expect(answer?.status).toBe('flexible')
    expect(answer?.flexible?.places.map((p) => [p.name, p.evidenceClass])).toEqual([
      ['Stone Mountain, GA', 'research_named'],
      ['Kingwood, TX', 'research_named'],
    ])
    expect(answer?.summary).toContain('none could be matched to Census data')
    expect(answer?.verification?.wonder).toBe('verified')
    expect(answer?.verification?.jev).toEqual({ roundsUsed: 0, passed: true })
    expect(typeof answer?.timings?.['flexible-draft']).toBe('number')
  })

  it('the flexible takeover re-issues the progress snapshot without its percent (FM-13)', async () => {
    const snapshots: { totalUnits: number | null; criteriaTotal: number }[] = []
    const answer = await composeAnswerForRequest({
      ...baseInput(async () => DRAFT, jevTransportWith(0.95)),
      onProgress: (snapshot) => {
        snapshots.push({ totalUnits: snapshot.totalUnits, criteriaTotal: snapshot.criteriaTotal })
      },
    })
    expect(answer?.status).toBe('flexible')
    // The strict stage emitted percent-bearing snapshots...
    expect(snapshots.some((s) => s.totalUnits !== null)).toBe(true)
    // ...and the last one, emitted at the flexible takeover, has
    // its total nulled (no bar, no percent on the flexible shape)
    // while keeping the strict run's true criteria count.
    const last = snapshots[snapshots.length - 1]!
    expect(last.totalUnits).toBeNull()
    expect(last.criteriaTotal).toBe(2)
  })

  it('a draft the validator rejects leaves the strict note standing (fail-closed)', async () => {
    const badDraft = {
      ...DRAFT,
      figures: [
        {
          label: 'Median gross rent',
          value: 9999,
          basis: 'census',
          censusKey: 'median_gross_rent',
          zcta: '96720',
        },
      ],
    }
    const answer = await composeAnswerForRequest(
      baseInput(async () => badDraft, jevTransportWith(0.95)),
    )
    expect(answer?.status).toBe('empty')
    expect(answer?.summary).toBe(NOT_MATCHED_NOTE)
    expect(answer?.flexible).toBeUndefined()
  })

  it('an unlabeled draft (parse failure) leaves the strict note standing', async () => {
    const answer = await composeAnswerForRequest(
      baseInput(
        async () => ({ prose: 'Some prose.', places: [], figures: [{ label: 'Outlets', value: 6 }] }),
        jevTransportWith(0.95),
      ),
    )
    expect(answer?.status).toBe('empty')
    expect(answer?.summary).toBe(NOT_MATCHED_NOTE)
  })

  it('the Jev loop patches the completion: the revised draft ships, gaps carried verbatim', async () => {
    const revisionGaps: string[][] = []
    let drafts = 0
    const answer = await composeAnswerForRequest(
      baseInput(async (req) => {
        drafts += 1
        const request = req as { revision?: { gaps: string[] } }
        if (request.revision) {
          revisionGaps.push([...request.revision.gaps])
          return { ...DRAFT, prose: `${DRAFT.prose} Revised: the school findings are stated per place.` }
        }
        return DRAFT
      }, jevTransportWith((call) => (call === 1 ? 0.3 : 0.95))),
    )
    expect(drafts).toBe(2)
    expect(revisionGaps).toHaveLength(1)
    expect(revisionGaps[0]!.join(' ')).toContain('School quality')
    expect(answer?.status).toBe('flexible')
    expect(answer?.flexible?.prose).toContain('Revised:')
    expect(answer?.verification?.jev).toEqual({ roundsUsed: 1, passed: true })
  })

  it('a strict card is never touched: matched research composes verified, no draft call', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({
        research: async () => ({
          prose: 'Hilo, HI schools are rated above the state average in the cited directory.',
          sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
        }),
      }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return DRAFT
        },
      },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toEqual(['Hilo, HI'])
    expect(flexibleCalls).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* Partial research tolerance (flexible-trigger cure, 2026-11-02)      */
/* ------------------------------------------------------------------ */

/**
 * The trigger gap's reachable terminal: researchPerCriterion runs
 * one pass per researched criterion, and before the cure ANY pass
 * failure threw out of the pipeline — so a dual-criteria question
 * whose first pass named places and whose second pass hit a
 * provider flap died at the App's compose-failed note with
 * research-named material already in hand (the terminal class
 * behind the owner's 2026-11-02 live finding on "lowest cost of
 * living but also the best schools?"). The cure: a failed pass is
 * recorded and the gathered material proceeds; only a TOTAL
 * research failure — no pass returned anything — still throws to
 * the honest note, by design.
 */
describe('partial research tolerance', () => {
  /** Pass 1 returns the unmatched-places findings; every later pass throws. */
  function flakyProvider() {
    let calls = 0
    return createStubProvider({
      research: async () => {
        calls += 1
        if (calls === 1) return UNMATCHED_RESEARCH
        throw new Error('provider_down')
      },
    })
  }

  it('a failed later pass keeps the gathered material and records the failure', async () => {
    const result = await researchPerCriterion(
      flakyProvider(),
      [],
      decomposeResearchCriteria(SENTENCE_1),
      SENTENCE_1,
      new AbortController().signal,
    )
    expect(result.claims.length).toBeGreaterThan(0)
    expect(result.sources).toEqual(UNMATCHED_RESEARCH.sources)
    expect(result.failedCriteria).toEqual(['Fast food restaurants'])
  })

  it('a total research failure still throws — no material, no completion', async () => {
    const provider = createStubProvider({
      research: async () => {
        throw new Error('provider_down')
      },
    })
    await expect(
      researchPerCriterion(
        provider,
        [],
        decomposeResearchCriteria(SENTENCE_1),
        SENTENCE_1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('provider_down')
  })

  it('the pipeline reaches the mismatch terminal on partial research, failure recorded', async () => {
    // Pass 1 returns schools-only findings (the fast-food pass is
    // the one that fails), so the failed criterion has no serving
    // claim and its evidence entry must state the lookup failure.
    let calls = 0
    const provider = createStubProvider({
      research: async () => {
        calls += 1
        if (calls === 1) {
          return {
            prose:
              'Stone Mountain, GA schools are rated above the state average in the cited directory.',
            sources: [{ title: 'State school directory', url: 'https://example.org/schools' }],
          }
        }
        throw new Error('provider_down')
      },
    })
    const answer = await runAnswerPipeline({
      intent: EXTERNAL_ONLY,
      rows: ROWS,
      researchQuery: SENTENCE_1,
      queryText: SENTENCE_1,
      provider,
    })
    expect(answer.status).toBe('empty')
    expect(answer.noCensusMatch).toBe(true)
    expect(answer.researchNamedPlaces).toEqual(['Stone Mountain, GA'])
    expect(answer.researchFailures).toEqual(['Fast food restaurants'])
    const failed = answer.criterionEvidence.find((e) => e.criterion === 'Fast food restaurants')
    expect(failed?.status).toBe('not_measurable')
    expect(failed?.detail).toContain('did not return')
    const served = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(served?.detail).not.toContain('did not return')
  })

  it('the runner completes the partial-failure terminal through the flexible lane', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: flakyProvider(),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return DRAFT
        },
      },
    })
    expect(flexibleCalls).toBe(1)
    expect(answer?.status).toBe('flexible')
    expect(answer?.researchFailures).toEqual(['Fast food restaurants'])
    expect(answer?.flexible?.places.map((p) => p.name)).toEqual([
      'Stone Mountain, GA',
      'Kingwood, TX',
    ])
  })
})

/* ------------------------------------------------------------------ */
/* Screen-path total research failure degrade (2026-11-02)             */
/* ------------------------------------------------------------------ */

/**
 * The screen-path compose throw (owner live finding, 2026-11-02
 * ~18:03 HST): "Where is the best schools and lowest cost of living
 * in Arkansas?" screened AR by median gross rent — the screen
 * succeeded and rendered — and then the Answer block showed the
 * bare compose-failed note. Diagnosis (drive-scratch RESULTS): the
 * question decomposes to exactly ONE researched pass (schools;
 * cost of living decomposes onto median_gross_rent), and
 * researchPerCriterion's zero-success rethrow — correct on the
 * research-first path, where research is the only leg — propagated
 * out of the screen path's stage 3 and discarded a complete Census
 * screen. The cure: the screen path asks for the total-failure
 * degrade (the failed criterion is recorded and composes onto the
 * card as a lookup failure); the research-first path keeps the
 * throw, exactly as the flexible-trigger cure dispositioned it.
 */
describe('screen-path research failure degrade', () => {
  const AR_QUESTION = 'Where is the best schools and lowest cost of living in Arkansas?'
  const AR_ROWS: AreaRow[] = [
    { zcta: '71601', name: 'Pine Bluff, AR', metrics: { median_gross_rent: 750 }, moes: { median_gross_rent: 40 } },
    { zcta: '71901', name: 'Hot Springs, AR', metrics: { median_gross_rent: 890 }, moes: { median_gross_rent: 55 } },
    { zcta: '72201', name: 'Little Rock, AR', metrics: { median_gross_rent: 1050 }, moes: { median_gross_rent: 60 } },
    { zcta: '72701', name: 'Fayetteville, AR', metrics: { median_gross_rent: 1150 }, moes: { median_gross_rent: 70 } },
  ]
  const AR_SCREEN: ValidatedIntent = {
    mode: 'sweep_filter',
    geographies: ['AR'],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
  }
  const downProvider = () =>
    createStubProvider({
      research: async () => {
        throw new Error('provider_down')
      },
    })

  it('the degrade posture returns empty material with every researched failure recorded', async () => {
    const result = await researchPerCriterion(
      downProvider(),
      [],
      decomposeResearchCriteria(SENTENCE_1),
      SENTENCE_1,
      new AbortController().signal,
      { tolerateTotalFailure: true },
    )
    expect(result.prose).toBe('')
    expect(result.claims).toEqual([])
    expect(result.sources).toEqual([])
    expect(result.failedCriteria).toEqual(['School quality', 'Fast food restaurants'])
  })

  it('the Arkansas screen composes its card with the schools lookup recorded as failed', async () => {
    const answer = await runAnswerPipeline({
      intent: AR_SCREEN,
      rows: AR_ROWS,
      geographyZctas: new Set(AR_ROWS.map((r) => r.zcta)),
      researchQuery: AR_QUESTION,
      queryText: AR_QUESTION,
      provider: downProvider(),
    })
    expect(answer.status).toBe('verified')
    // The screen's own order: lowest median gross rent first.
    expect(answer.places.map((p) => p.name)).toEqual([
      'Pine Bluff, AR',
      'Hot Springs, AR',
      'Little Rock, AR',
      'Fayetteville, AR',
    ])
    expect(answer.researchFailures).toEqual(['School quality'])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.status).toBe('not_measurable')
    expect(schools?.detail).toContain('did not return')
    // The decomposed cost criterion is assessed from the figures,
    // measured — the degrade touches only the failed lookup.
    const cost = answer.criterionEvidence.find((e) => e.criterion === 'Cost of living')
    expect(cost?.status).toBe('met')
    // The summary names the unmeasured criterion; it never claims
    // the stated criteria were all met.
    expect(answer.summary).toContain('Not measured here')
    expect(answer.summary).toContain('School quality')
  })

  it('the research-first path lands its honest note on total research failure — the boundary moved into the pipeline', async () => {
    // Before the compose-degradation cure (2026-11-03) this case
    // pinned the throw: the screen path degraded and the
    // research-first path rethrew, the boundary between them
    // deliberate. The cure removed the throw — a placeless total
    // failure now composes the honest-note terminal in-pipeline
    // (the state-bounded arm degrades onto its screen instead),
    // and this pin holds the new boundary: the note, with every
    // researched failure recorded, never a rejection.
    const answer = await runAnswerPipeline({
      intent: EXTERNAL_ONLY,
      rows: ROWS,
      researchQuery: SENTENCE_1,
      queryText: SENTENCE_1,
      provider: downProvider(),
    })
    expect(answer.status).toBe('empty')
    expect(answer.places).toEqual([])
    expect(answer.summary).toContain('did not return')
    expect(answer.researchFailures).toEqual(['School quality', 'Fast food restaurants'])
    expect(answer.noCensusMatch).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* K0: the answer-every-time floor (owner directive, 2026-11-03)       */
/* ------------------------------------------------------------------ */

/**
 * The owner's phone specimen on production 6027031: a researched
 * place question whose findings named places only in bare form,
 * zero resolved, terminated on the no-place note — although the
 * flexible lane exists to complete exactly that terminal. The
 * diagnosis, from source: (1) the pipeline stamped
 * researchNamedPlaces with `extracted` only, leaving the bare
 * ambiguous/unresolved buckets — where this shape's names live —
 * out of the field the completion's packet and provenance
 * validator read, so the lane was offered none of the findings'
 * names and rejected drafts naming them; (2) bare extraction
 * dismantled a multi-word lead ("University City") into a shorter
 * different place ("University") when the whole form found no
 * hit; (3) a generic fragment ("City") recorded as an ambiguous
 * NAME through the bound-completion branch, which never applied
 * the FM-20 fragment gate the byBare branch applies. The pins
 * below hold the cures per class, plus the floor's fences: a
 * total research failure still completes nothing, and a draft
 * that keeps failing the validator still leaves the note.
 */

const K0_ROWS: AreaRow[] = [
  ...ROWS,
  { zcta: '33612', name: 'University, FL', metrics: { median_gross_rent: 1390 }, moes: { median_gross_rent: 90 } },
  { zcta: '38677', name: 'University, MS', metrics: { median_gross_rent: 890 }, moes: { median_gross_rent: 140 } },
  { zcta: '64106', name: 'Kansas City, MO', metrics: { median_gross_rent: 1050 }, moes: { median_gross_rent: 60 } },
  { zcta: '33701', name: 'St. Petersburg, FL', metrics: { median_gross_rent: 1531 }, moes: { median_gross_rent: 84 } },
]

const K0_BARE_ONLY_RESEARCH = {
  prose:
    'University City is praised for its schools in the cited guide. ' +
    'Petersburg is known for its few fast-food outlets.',
  sources: [{ title: 'Regional guide', url: 'https://example.org/guide' }],
}

const K0_DRAFT = {
  prose:
    'The cited research named University City for the stated school criterion and ' +
    'Petersburg for the fast-food criterion; both are shown with the evidence behind them.',
  places: [
    { name: 'University City', basis: 'research', note: 'Named by the cited research for school quality.', figures: [] },
    { name: 'Petersburg', basis: 'research', note: 'Named by the cited research for few fast-food outlets.', figures: [] },
  ],
  figures: [],
}

describe('K0 extraction wholeness', () => {
  it('a multi-word lead records whole when its descended prefix is only an ambiguous fragment of it', () => {
    const bare = extractBareCandidateNames(
      'University City is an inner-ring suburb praised for its schools.',
      [],
      K0_ROWS,
    )
    expect(bare.names).toEqual([])
    expect(bare.ambiguous).toEqual(['University City'])
    expect(bare.unresolved).toEqual([])
    expect(bare.fragments).toBe(0)
  })

  it('a generic fragment completing ambiguously against the bound counts as a fragment, never a name', () => {
    const boundRows: AreaRow[] = [
      { zcta: '64106', name: 'Kansas City, MO', metrics: {}, moes: {} },
      { zcta: '73102', name: 'Oklahoma City, OK', metrics: {}, moes: {} },
      { zcta: '33701', name: 'St. Petersburg, FL', metrics: {}, moes: {} },
    ]
    const bare = extractBareCandidateNames(
      'City leaders announced a new school plan this week.',
      [],
      boundRows,
      boundRows,
    )
    expect(bare.names).toEqual([])
    expect(bare.ambiguous).toEqual([])
    expect(bare.unresolved).toEqual([])
    expect(bare.fragments).toBe(1)
  })

  it('a descended prefix that resolves uniquely still resolves (New York City -> New York)', () => {
    const rows: AreaRow[] = [
      { zcta: '10001', name: 'New York, NY', metrics: {}, moes: {} },
      { zcta: '64106', name: 'Kansas City, MO', metrics: {}, moes: {} },
    ]
    const bare = extractBareCandidateNames(
      'New York City is described as a major cultural center.',
      [],
      rows,
    )
    expect(bare.names).toEqual(['New York, NY'])
    expect(bare.ambiguous).toEqual([])
  })
})

describe('K0 the floor at the pipeline and the runner', () => {
  it('the pipeline stamps the FULL extraction record: bare ambiguous and bare unresolved names included', async () => {
    const provider = createStubProvider({ research: async () => K0_BARE_ONLY_RESEARCH })
    const answer = await runAnswerPipeline({
      intent: EXTERNAL_ONLY,
      rows: K0_ROWS,
      researchQuery: SENTENCE_1,
      queryText: SENTENCE_1,
      provider,
    })
    expect(answer.status).toBe('empty')
    expect(answer.noCensusMatch).toBe(true)
    expect(answer.summary).toBe(NOT_MATCHED_NOTE)
    // The whole multi-word name, never its fragment.
    expect(answer.unresolvedCandidates).toContain('University City')
    expect(answer.unresolvedCandidates).not.toContain('University')
    expect(answer.unresolvedCandidates).toContain('Petersburg')
    expect(answer.researchNamedPlaces).toEqual(
      expect.arrayContaining(['University City', 'Petersburg']),
    )
  })

  it('the specimen shape completes: bare-only names are offered to the draft and pass provenance', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: K0_ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({ research: async () => K0_BARE_ONLY_RESEARCH }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return K0_DRAFT
        },
      },
    })
    expect(flexibleCalls).toBe(1)
    expect(answer?.status).toBe('flexible')
    expect(answer?.flexible?.places.map((p) => [p.name, p.evidenceClass])).toEqual([
      ['University City', 'research_named'],
      ['Petersburg', 'research_named'],
    ])
    // The no-place evidence entries restamped: the completed card
    // shows places, so no entry may still state that none could
    // be shown.
    const entry = answer?.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(entry?.status).toBe('met')
    expect(entry?.detail).toContain('completed answer below')
  })

  it('a validator-rejected draft gets ONE bounded re-draft carrying the failure strings, then completes', async () => {
    const seen: { revision?: { gaps: string[] } }[] = []
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: K0_ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({ research: async () => K0_BARE_ONLY_RESEARCH }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async (req: unknown) => {
          const request = req as { revision?: { gaps: string[] } }
          seen.push(request)
          if (!request.revision) {
            return {
              prose: 'Atlantis is the place.',
              places: [{ name: 'Atlantis', basis: 'research', figures: [] }],
              figures: [],
            }
          }
          return K0_DRAFT
        },
      },
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]?.revision?.gaps.join(' ')).toContain('Atlantis')
    expect(answer?.status).toBe('flexible')
  })

  it('a draft that keeps failing the validator leaves the note standing, with exactly two draft calls', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: K0_ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({ research: async () => K0_BARE_ONLY_RESEARCH }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return {
            prose: 'Atlantis is the place.',
            places: [{ name: 'Atlantis', basis: 'research', figures: [] }],
            figures: [],
          }
        },
      },
    })
    expect(flexibleCalls).toBe(2)
    expect(answer?.status).toBe('empty')
    expect(answer?.summary).toBe(NOT_MATCHED_NOTE)
    expect(answer?.flexible).toBeUndefined()
  })

  it('a zero-place draft fails the gate when the research named places; the re-draft can cure it', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: K0_ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({ research: async () => K0_BARE_ONLY_RESEARCH }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return flexibleCalls === 1
            ? { prose: 'Some prose with no places.', places: [], figures: [] }
            : K0_DRAFT
        },
      },
    })
    expect(flexibleCalls).toBe(2)
    expect(answer?.status).toBe('flexible')
    expect(answer?.flexible?.places).toHaveLength(2)
  })

  it('a total research failure completes nothing: no material, no draft call, the honest note stands', async () => {
    let flexibleCalls = 0
    const answer = await composeAnswerForRequest({
      intent: EXTERNAL_ONLY,
      queryText: SENTENCE_1,
      rows: K0_ROWS,
      resolved: resolveAnswerGeographies(EXTERNAL_ONLY, null),
      provider: createStubProvider({
        research: async () => {
          throw new Error('provider down')
        },
      }),
      research: true,
      stack: {
        decisions: {},
        ...NO_PLAN,
        ...VERIFIED_BOOKEND,
        jevTransport: jevTransportWith(0.95),
        flexibleTransport: async () => {
          flexibleCalls += 1
          return K0_DRAFT
        },
      },
    })
    expect(flexibleCalls).toBe(0)
    expect(answer?.status).toBe('empty')
    expect(answer?.summary).toContain('did not return')
  })
})

/* ------------------------------------------------------------------ */
/* K1 — reliability: the resolution re-ask + interim narration        */
/* (2026-11-03 completion program; Jev gate proceed / destructive     */
/* 0.10 / advances 0.96 under policy v1)                              */
/* ------------------------------------------------------------------ */

const K1_ROWS: AreaRow[] = [
  ...ROWS,
  { zcta: '33602', name: 'Tampa, FL', metrics: { median_gross_rent: 1280 }, moes: { median_gross_rent: 70 } },
  { zcta: '78701', name: 'Austin, TX', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 80 } },
]

function k1ResearchStub(responses: Array<{ prose: string; claims: string[] } | Error>) {
  const queries: string[] = []
  let call = 0
  const provider = createStubProvider({
    research: (input) => {
      queries.push(input.queryText)
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      if (response instanceof Error) throw response
      return {
        prose: response.prose,
        sources: [{ url: 'https://example.org/k1', title: 'K1 source' }],
      }
    },
  })
  return { provider, queries, calls: () => call }
}

const K1_INTENT_FL: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['FL'],
  metricKeys: [],
  filters: [],
  clarificationNeeded: false,
}

describe('K1 the resolution re-ask', () => {
  it('a zero-yield stage gets one steered re-ask, and the merged yield cards', async () => {
    const stub = k1ResearchStub([
      {
        prose: 'Educators mention Traverse City, MI for its schools.',
        claims: ['Traverse City, MI is known for its schools.'],
      },
      {
        prose: 'Families also name Tampa, FL for its schools.',
        claims: ['Tampa, FL is known for its schools.'],
      },
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: K1_INTENT_FL,
      rows: K1_ROWS,
      researchQuery: 'best schools in florida',
      queryText: 'best schools in florida',
      researchCriteria: ['best schools in florida'],
    })
    expect(stub.calls()).toBe(2)
    expect(stub.queries[1]).toContain('incorporated cities or towns')
    expect(stub.queries[1]).toContain('U.S. Census data')
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Tampa, FL')
  })

  it('a double zero-yield stays bounded (stage, one re-ask, one second draw) and keeps the honest note shape', async () => {
    const stub = k1ResearchStub([
      {
        prose: 'Educators mention Traverse City, MI for its schools.',
        claims: ['Traverse City, MI is known for its schools.'],
      },
      {
        prose: 'Educators also mention Marquette, MI for its schools.',
        claims: ['Marquette, MI is known for its schools.'],
      },
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: K1_INTENT_FL,
      rows: K1_ROWS,
      researchQuery: 'best schools in florida',
      queryText: 'best schools in florida',
      researchCriteria: ['best schools in florida'],
    })
    // CHANGED 2026-11-04 (Q6 round 4): the count was 2 — first
    // stage plus the one resolution re-ask. The bounded second
    // draw (one further stage, varied steering) now fires on a
    // run still grounding zero with material in hand — this
    // pin's shape exactly — bringing the total to 3 stage calls.
    // The boundedness this pin protects is unchanged in kind:
    // one re-ask and one second draw, never a loop, and the
    // terminal assertions below are byte-identical.
    expect(stub.calls()).toBe(3)
    expect(answer.status).toBe('empty')
    expect(answer.noCensusMatch).toBe(true)
    // K3 adaptation (2026-11-03): both names carry an explicit MI
    // suffix against this pin's Florida bound, so the state-
    // contradiction partition accounts them as out-of-state names
    // rather than in the ordinary unmatched record. The boundedness
    // and terminal assertions above are unchanged.
    expect(answer.outOfStateCandidates).toContain('Traverse City, MI')
    expect(answer.outOfStateCandidates).toContain('Marquette, MI')
    expect(answer.unresolvedCandidates).not.toContain('Traverse City, MI')
  })

  it('a re-ask failure keeps the first yield untouched', async () => {
    const stub = k1ResearchStub([
      {
        prose: 'Educators mention Traverse City, MI for its schools.',
        claims: ['Traverse City, MI is known for its schools.'],
      },
      new Error('re-ask transport down'),
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: K1_INTENT_FL,
      rows: K1_ROWS,
      researchQuery: 'best schools in florida',
      queryText: 'best schools in florida',
      researchCriteria: ['best schools in florida'],
    })
    // Five provider calls: the first stage, then the re-ask stage's
    // own two attempts — researchPerCriterion's FM-11 discipline
    // retries a totally-failed stage once before it throws, and the
    // throw is what lands here — then the second draw's stage and
    // its own two attempts (CHANGED 2026-11-04, Q6 round 4: the
    // bounded second draw fires on the still-zero run, and its
    // failure, exactly like the re-ask's, keeps the first yield
    // untouched). The bound that matters is the pipeline's: ONE
    // resolution re-ask and ONE second draw, never a loop.
    expect(stub.calls()).toBe(5)
    expect(answer.status).toBe('empty')
    // K3 partition, as in the double zero-yield pin above: the
    // first yield's name is accounted as an out-of-state name
    // against the Florida bound — present, under its own record.
    expect(answer.outOfStateCandidates).toContain('Traverse City, MI')
  })

  it('a run that cards on the first yield never re-asks', async () => {
    const stub = k1ResearchStub([
      {
        prose: 'Families name Tampa, FL for its schools.',
        claims: ['Tampa, FL is known for its schools.'],
      },
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: K1_INTENT_FL,
      rows: K1_ROWS,
      researchQuery: 'best schools in florida',
      queryText: 'best schools in florida',
      researchCriteria: ['best schools in florida'],
    })
    expect(stub.calls()).toBe(1)
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Tampa, FL')
  })

  it('a claims-rich stage with zero extractable names gets the steered re-ask (the Texas shape)', async () => {
    // The specimen's exact shape (2026-11-03): the research prose
    // discusses the place in claims, but every mention is bare and
    // mid-sentence in lowercase — standard extraction needs
    // "Name, ST", bare extraction needs a sentence-initial lead —
    // so the extraction record is empty while the stage's claims
    // are not. Before the cure the re-ask's extraction-only
    // condition deterministically declined to fire here.
    const stub = k1ResearchStub([
      {
        prose:
          'The city most often described as the state\u2019s liberal capital is austin, ' +
          'a university city whose politics the cited guide calls strongly progressive.',
        claims: ['The cited guide calls austin strongly progressive.'],
      },
      {
        prose: 'Travel guides name Austin, TX as the state\u2019s most liberal city.',
        claims: ['Austin, TX is named the state\u2019s most liberal city.'],
      },
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: { mode: 'lookup', geographies: ['TX'], metricKeys: [], filters: [], clarificationNeeded: false },
      rows: K1_ROWS,
      researchQuery: 'most liberal city in texas',
      queryText: 'What is the most liberal city in Texas?',
      researchCriteria: ['most liberal'],
    })
    expect(stub.calls()).toBe(2)
    expect(stub.queries[1]).toContain('incorporated cities or towns')
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Austin, TX')
  })

  it('a stage empty in every channel gets no resolution re-ask (FM-11 owns that ground)', async () => {
    const stub = k1ResearchStub([
      { prose: '', claims: [] },
      { prose: '', claims: [] },
    ])
    const answer = await runAnswerPipeline({
      provider: stub.provider,
      intent: { mode: 'lookup', geographies: ['TX'], metricKeys: [], filters: [], clarificationNeeded: false },
      rows: K1_ROWS,
      researchQuery: 'most liberal city in texas',
      queryText: 'What is the most liberal city in Texas?',
      researchCriteria: ['most liberal'],
    })
    // Two provider calls, both inside the stage's own FM-11
    // discipline (first attempt + its one re-ask); the pipeline's
    // resolution re-ask never fires — a third call would be its
    // signature, and there is none.
    // CHANGED (Q6 round 3, 2026-11-04): the pin's original
    // assertion — no query carries the nomination steering — no
    // longer separates the shapes, because the steering now rides
    // the FIRST research-first pass by design (the bare question
    // is the shape that returned the demo question's no-place
    // yield live). The behavior this pin protects is unchanged:
    // an all-empty stage is FM-11's ground, the pipeline adds no
    // re-ask of its own, and the call count is the assertion.
    expect(stub.calls()).toBe(2)
    expect(answer.status).toBe('empty')
  })
})

describe('flexible packet screen-outcome line', () => {
  it('states the shape that occurred: named-but-unmatched vs no recordable place', () => {
    const named = buildFlexiblePacketText({
      question: 'What is the most liberal city in Texas?',
      criteria: ['most liberal'],
      researchPlaces: ['Austin, TX'],
      claims: [{ text: 'Austin is described as strongly liberal.', sourceUrls: ['https://example.org/x'] }],
      sources: [{ title: 'Guide', url: 'https://example.org/x' }],
    })
    expect(named).toContain('the cited research named places for the stated criteria')
    expect(named).toContain('PLACES THE RESEARCH NAMED: Austin, TX')
    const unrecorded = buildFlexiblePacketText({
      question: 'What is the most liberal city in Texas?',
      criteria: ['most liberal'],
      researchPlaces: [],
      claims: [{ text: 'The guide calls the capital city strongly progressive.', sourceUrls: ['https://example.org/x'] }],
      sources: [{ title: 'Guide', url: 'https://example.org/x' }],
    })
    expect(unrecorded).toContain('no place in those findings could be recorded')
    expect(unrecorded).not.toContain('the cited research named places')
    // No named-places line (the packet's static rules text mentions
    // the label without the colon; the line itself carries one).
    expect(unrecorded).not.toContain('PLACES THE RESEARCH NAMED:')
  })
})

describe('K1 interim-state narration', () => {
  it('the interim line drops; the finding form survives', () => {
    const { prose, dropped } = filterWorkingNarration(
      'Initial results point to Austin. Austin, TX is described by residents as strongly liberal.',
      [],
    )
    expect(dropped).toContain('Initial results point to Austin.')
    expect(prose).toContain('Austin, TX is described by residents as strongly liberal.')
    expect(prose).not.toContain('Initial results')
  })

  it('a source-reporting sentence with the interim subject but no direction verb survives', () => {
    const { prose, dropped } = filterWorkingNarration(
      'Initial findings from the county survey recorded high satisfaction among residents.',
      [],
    )
    expect(dropped).toEqual([])
    expect(prose).toContain('Initial findings from the county survey')
  })

  it('the interim claim never reaches a terminal card', async () => {
    const provider = createStubProvider({
      research: () => ({
        prose:
          'Initial results point to Austin, TX as the most liberal. ' +
          'Austin, TX is described by the cited guide as strongly liberal.',
        sources: [{ url: 'https://example.org/k1tx', title: 'K1 Texas source' }],
      }),
    })
    const answer = await runAnswerPipeline({
      provider,
      intent: {
        mode: 'lookup',
        geographies: ['TX'],
        metricKeys: [],
        filters: [],
        clarificationNeeded: false,
      },
      rows: K1_ROWS,
      researchQuery: 'most liberal city in texas',
      queryText: 'most liberal city in texas',
      researchCriteria: ['most liberal city in texas'],
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Austin, TX')
    expect(answer.droppedClaims?.map((c) => c.text).join(' ')).toContain(
      'Initial results point to Austin',
    )
    const keptClaims = answer.places.flatMap((p) => p.claims.map((c) => c.text)).join(' ')
    expect(keptClaims).not.toContain('Initial results')
    expect(keptClaims).toContain('strongly liberal')
  })
})
