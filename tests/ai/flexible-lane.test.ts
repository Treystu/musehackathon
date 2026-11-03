import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import {
  decomposeResearchCriteria,
  researchPerCriterion,
  runAnswerPipeline,
  type ComposedAnswer,
} from '../../src/core/ai/answer'
import {
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
  'Research for the stated criteria did not name a place that could be matched to Census data, so no place is named here.'

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
