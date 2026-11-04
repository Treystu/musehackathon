import { describe, expect, it } from 'vitest'
import type { AreaRow } from '../../src/core/plugins/acs'
import { createStubProvider, type ValidatedIntent } from '../../src/core/ai/provider'
import { runAnswerPipeline, type ComposedAnswer } from '../../src/core/ai/answer'
import {
  composeAnswerForRequest,
  resolveAnswerGeographies,
} from '../../src/ui/ai/answer-runner'
import { composeGeneralAnswer } from '../../src/ui/ai/general-runner'
import type { JevAnswer, JevTransport } from '../../src/core/ai/jev-judgments'

/**
 * Compose-degradation pins (owner fail-free bar, 2026-11-03: no
 * partial fails, no failures in any regard).
 *
 * Live evidence (hosted-browser capture on production df91134,
 * 2026-11-03 ~01:52 HST; portal diagnostics corroborate: +1
 * provider_down recorded server-side across the run window, breaker
 * closed): the Colorado nature+cost question routed research-first
 * correctly and then terminated at the bare compose-failure note —
 * "The answer to this question could not be composed just now" —
 * after ONE upstream provider failure. That note is rendered by the
 * App only when composeAnswerForRequest REJECTS, so every pin below
 * asserts the runner/pipeline seam directly: with material in hand,
 * a single-stage provider failure must RESOLVE to the degraded
 * terminal the ladder prescribes (research material -> its card;
 * screen in hand -> the screen card with researched criteria
 * stamped lookup-failed; a draft whose bookend fails -> the answer
 * lands, never labeled verified by that bookend; NOTHING in hand ->
 * the honest note answer). A rejection is the bare terminal and
 * fails every pin that forbids it.
 *
 * The injection matrix (stage x path) was run pre-cure to map the
 * surface; the pre-cure terminals are recorded in the lane RESULTS
 * (drive-scratch/compose-degradation). Cells marked CONTROL already
 * degraded before the cure and pin that the cure changed nothing
 * there.
 */

const COLORADO_Q = 'what city in Colorado has the best nature and the lowest cost of living?'
const SENTENCE_TWO = 'What are the top five places that have the best schools but also the least average cost of living?'
const DID_NOT_RETURN = 'did not return'

const CO_ROWS: AreaRow[] = [
  { zcta: '81090', name: 'Walsh, CO', metrics: { median_gross_rent: 283, median_home_value: 151100 }, moes: { median_gross_rent: 273, median_home_value: 71979 } },
  { zcta: '81047', name: 'Holly, CO', metrics: { median_gross_rent: 293, median_home_value: 157700 }, moes: { median_gross_rent: 282, median_home_value: 55661 } },
  { zcta: '81334', name: 'Towaoc, CO', metrics: { median_gross_rent: 349, median_home_value: null }, moes: { median_gross_rent: 191, median_home_value: null } },
  { zcta: '81001', name: 'Pueblo, CO', metrics: { median_gross_rent: 1050, median_home_value: 210000 }, moes: { median_gross_rent: 40, median_home_value: 5000 } },
  { zcta: '81003', name: 'Pueblo, CO', metrics: { median_gross_rent: 1100, median_home_value: 195000 }, moes: { median_gross_rent: 45, median_home_value: 6000 } },
  { zcta: '81611', name: 'Aspen, CO', metrics: { median_gross_rent: 2400, median_home_value: 2400000 }, moes: { median_gross_rent: 300, median_home_value: 200000 } },
  { zcta: '80424', name: 'Breckenridge, CO', metrics: { median_gross_rent: 1900, median_home_value: 1500000 }, moes: { median_gross_rent: 250, median_home_value: 150000 } },
  { zcta: '81301', name: 'Durango, CO', metrics: { median_gross_rent: 1500, median_home_value: 650000 }, moes: { median_gross_rent: 90, median_home_value: 30000 } },
  { zcta: '99901', name: 'Norent, CO', metrics: { median_gross_rent: null, median_home_value: 90000 }, moes: { median_gross_rent: null, median_home_value: 9000 } },
]

const HI_ROWS: AreaRow[] = [
  { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1450 }, moes: { median_gross_rent: 85 } },
  { zcta: '96749', name: 'Keaau, HI', metrics: { median_gross_rent: 1325 }, moes: { median_gross_rent: 120 } },
  { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1750 }, moes: { median_gross_rent: 150 } },
]

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'sweep_filter',
    geographies: [],
    metricKeys: ['median_gross_rent'],
    filters: [],
    clarificationNeeded: false,
    ...partial,
  }
}

/** Every research call fails, the provider_down window. */
function downProvider(calls?: { count: number }) {
  return createStubProvider({
    async research() {
      if (calls) calls.count++
      throw new Error('provider_down')
    },
  })
}

/** The accounting invariant: every parsed criterion has exactly one evidence line. */
function expectEveryCriterionAccounted(answer: ComposedAnswer) {
  for (const criterion of answer.researchCriteria) {
    const entries = answer.criterionEvidence.filter((e) => e.criterion === criterion.label)
    expect(entries, `criterion "${criterion.label}" accounting lines`).toHaveLength(1)
  }
}

const NO_JEV: JevTransport = async () => {
  throw new Error('jev route: HTTP 500')
}
const NULL_PLAN = async () => null
const NULL_VERIFY = async () => null
const THROWING_PLAN = async (): Promise<never> => {
  throw new Error('plan route: HTTP 500')
}
const THROWING_VERIFY = async (): Promise<never> => {
  throw new Error('verify route: HTTP 500')
}

/* ------------------------------------------------------------------ */
/* Pipeline: research-first arms under a total research failure        */
/* ------------------------------------------------------------------ */

describe('pipeline: research-first, total research failure', () => {
  it('CONTROL — state-bounded with retained measures degrades onto the state screen card', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['CO'], metricKeys: ['median_gross_rent', 'median_home_value'] }),
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: downProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.length).toBeGreaterThan(0)
    expect(answer.researchFailures).toContain('Nature and outdoors')
    const nature = answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')
    expect(nature?.detail).toContain(DID_NOT_RETURN)
    expectEveryCriterionAccounted(answer)
  })

  it('state-bounded with NO retained measures degrades onto the state screen card (the live intent shape)', async () => {
    // The live parse's intent shape is a model call's output; when
    // it carries the cost measure only in the criterion
    // decomposition and leaves metricKeys empty, the pre-cure
    // degrade gate (which required retained measures) did not hold
    // and the single failed pass discarded a complete state screen.
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['CO'], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: COLORADO_Q,
      researchCriteria: [COLORADO_Q],
      queryText: COLORADO_Q,
      provider: downProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.length).toBeGreaterThan(0)
    expect(answer.researchFailures).toContain('Nature and outdoors')
    const nature = answer.criterionEvidence.find((e) => e.criterion === 'Nature and outdoors')
    expect(nature?.detail).toContain(DID_NOT_RETURN)
    expectEveryCriterionAccounted(answer)
  })

  it('state-bounded, combined criterion only, degrades onto the state screen card', async () => {
    const text = 'What is the cheapest place to live in Colorado?'
    const calls = { count: 0 }
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['CO'], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: downProvider(calls),
    })
    expect(calls.count).toBeGreaterThan(0)
    expect(answer.status).toBe('verified')
    expect(answer.places.length).toBeGreaterThan(0)
    expect(answer.researchFailures).toContain('Outside-Census criteria')
    expectEveryCriterionAccounted(answer)
  })

  // The 2026-11-03 live specimen (scenario-coverage seat): "Which is
  // cheaper, Hilo or East Honolulu?" — the parse retained no measures,
  // so the combined carry was the only criterion; research-first
  // engaged over the two named places; research failed on both
  // attempts; pre-cure the terminal keyed on the research outcome and
  // named NO place while the screened comparison sat in hand. The
  // degrade rule is about the screen's shape, not the bound's kind:
  // when the screen is bounded to the named places' own rows, that
  // screen IS the answer and the research failure is recorded on it.
  const CHEAPER_Q = 'Which is cheaper, Hilo or East Honolulu?'
  const HI_COMPARE_ROWS: AreaRow[] = [
    { zcta: '96720', name: 'Hilo, HI', metrics: { median_gross_rent: 1346, median_home_value: 458100, median_household_income: 77331 }, moes: { median_gross_rent: 52, median_home_value: 12269, median_household_income: 4536 } },
    { zcta: '96778', name: 'Pahoa, HI', metrics: { median_gross_rent: 1259, median_home_value: 331300, median_household_income: 46563 }, moes: { median_gross_rent: 316, median_home_value: 56083, median_household_income: 7413 } },
    { zcta: '96821', name: 'East Honolulu, HI', metrics: { median_gross_rent: 2946, median_home_value: 1457700, median_household_income: 151455 }, moes: { median_gross_rent: 338, median_home_value: 85996, median_household_income: 10633 } },
  ]

  it('named places bound in hand, no retained measures: total failure degrades onto the named-places card', async () => {
    const calls = { count: 0 }
    const answer = await runAnswerPipeline({
      intent: intent({ mode: 'compare', geographies: ['Hilo, HI', 'East Honolulu, HI'], metricKeys: [] }),
      rows: HI_COMPARE_ROWS,
      geographyZctas: new Set(['96720', '96821']),
      researchQuery: CHEAPER_Q,
      queryText: CHEAPER_Q,
      provider: downProvider(calls),
    })
    // Research was genuinely attempted (stage + re-ask) and its
    // failure is recorded — the cure is at terminal selection, not
    // at engagement.
    expect(calls.count).toBe(2)
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name).sort()).toEqual(['East Honolulu, HI', 'Hilo, HI'])
    expect(answer.summary).not.toContain('no place is named')
    // The screened comparison rides the card: with no measure
    // retained anywhere, the named-places figure pull supplies the
    // headline money figures from the rows, margins included.
    const hilo = answer.places.find((p) => p.name === 'Hilo, HI')!
    const east = answer.places.find((p) => p.name === 'East Honolulu, HI')!
    expect(hilo.figures).toContainEqual(expect.objectContaining({ key: 'median_gross_rent', value: 1346, marginOfError: 52 }))
    expect(hilo.figures).toContainEqual(expect.objectContaining({ key: 'median_home_value', value: 458100 }))
    expect(east.figures).toContainEqual(expect.objectContaining({ key: 'median_gross_rent', value: 2946, marginOfError: 338 }))
    expect(east.figures).toContainEqual(expect.objectContaining({ key: 'median_home_value', value: 1457700 }))
    expect(answer.researchFailures).toContain('Outside-Census criteria')
    expectEveryCriterionAccounted(answer)
  })

  it('CONTROL — named places that never resolved to rows: total failure still lands the honest note', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ mode: 'compare', geographies: ['Hilo, HI', 'East Honolulu, HI'], metricKeys: [] }),
      rows: HI_COMPARE_ROWS,
      researchQuery: CHEAPER_Q,
      queryText: CHEAPER_Q,
      provider: downProvider(),
    })
    expect(answer.status).toBe('empty')
    expect(answer.places).toHaveLength(0)
    expect(answer.summary).toContain(DID_NOT_RETURN)
    expectEveryCriterionAccounted(answer)
  })

  it('placeless: total failure lands the honest note answer, never a throw', async () => {
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: SENTENCE_TWO,
      researchCriteria: [SENTENCE_TWO],
      queryText: SENTENCE_TWO,
      provider: downProvider(),
    })
    expect(answer.status).toBe('empty')
    expect(answer.places).toHaveLength(0)
    expect(answer.summary).toContain(DID_NOT_RETURN)
    expect(answer.researchFailures).toContain('School quality')
    // No marker, no named places: the flexible fall-through keys
    // on what research returned, and a total failure returned
    // nothing to ground a completion on.
    expect(answer.noCensusMatch).toBeUndefined()
    expect(answer.researchNamedPlaces).toEqual([])
    const schools = answer.criterionEvidence.find((e) => e.criterion === 'School quality')
    expect(schools?.detail).toContain(DID_NOT_RETURN)
    expectEveryCriterionAccounted(answer)
  })

  it('CONTROL — placeless partial failure keeps the surviving pass material', async () => {
    let calls = 0
    const provider = createStubProvider({
      async research() {
        calls++
        if (calls === 1) {
          return {
            prose: 'Durango, CO schools are rated above the state average in the cited directory.',
            sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
          }
        }
        throw new Error('provider_down')
      },
    })
    // ADAPTED (Lane A9 FM-3b): the shipped control paired schools
    // with the combined criterion and failed the SECOND call. The
    // pass plan gives the combined class no pass of its own beside
    // a named criterion — every pass queries the whole question, so
    // the gathering is one call and there is no second call to
    // fail. The control's invariant (a partial failure keeps the
    // surviving material and records the failed criterion) is now
    // exercised on two NAMED criteria, and the combined pairing is
    // asserted separately below on the new plan's own terms.
    const text = 'best schools and the most coffee shops'
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider,
    })
    expect(answer.status).toBe('verified')
    expect(answer.places.map((p) => p.name)).toContain('Durango, CO')
    expect(answer.researchFailures).toContain('Coffee nearby')
    expectEveryCriterionAccounted(answer)

    // The combined pairing on the pass plan: one call total, the
    // combined criterion accounted from the gathered material, no
    // failure recorded for a call that does not exist.
    let combinedCalls = 0
    const combinedProvider = createStubProvider({
      async research() {
        combinedCalls++
        return {
          prose: 'Durango, CO schools are rated above the state average in the cited directory.',
          sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
        }
      },
    })
    const combinedText = 'best schools and the quietest streets'
    const combinedAnswer = await runAnswerPipeline({
      intent: intent({ geographies: [], metricKeys: [] }),
      rows: CO_ROWS,
      researchQuery: combinedText,
      researchCriteria: [combinedText],
      queryText: combinedText,
      provider: combinedProvider,
    })
    expect(combinedCalls).toBe(1)
    expect(combinedAnswer.status).toBe('verified')
    expect(combinedAnswer.researchFailures).toBeUndefined()
    expectEveryCriterionAccounted(combinedAnswer)
  })
})

/* ------------------------------------------------------------------ */
/* Pipeline: screen-first arm under a total research failure           */
/* ------------------------------------------------------------------ */

describe('pipeline: screen-first, total research failure', () => {
  it('CONTROL — the Nashville shape degrades onto its screen card', async () => {
    const rows: AreaRow[] = [
      { zcta: '37210', name: 'Nashville, TN', metrics: { median_household_income: 43343 }, moes: { median_household_income: 6619 } },
      { zcta: '37115', name: 'Nashville, TN', metrics: { median_household_income: 53034 }, moes: { median_household_income: 2860 } },
    ]
    const text = "Where can I move around Nashville that's got good schools and high wages"
    const answer = await runAnswerPipeline({
      intent: intent({ geographies: ['Nashville'], metricKeys: ['median_household_income'] }),
      rows,
      researchQuery: text,
      researchCriteria: [text],
      queryText: text,
      provider: downProvider(),
    })
    expect(answer.status).toBe('verified')
    expect(answer.places).toHaveLength(2)
    expect(answer.researchFailures).toContain('School quality')
    expectEveryCriterionAccounted(answer)
  })
})

/* ------------------------------------------------------------------ */
/* Runner: bookend transport failures                                  */
/* ------------------------------------------------------------------ */

describe('runner: bookend transport failures', () => {
  const starbucksQuery = 'places with a Starbucks nearby where rent is under $1,500'
  const starbucksIntent = () =>
    intent({ filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }] })
  const starbucksProvider = () =>
    createStubProvider({
      async research() {
        return {
          prose: 'Hilo, HI has a Starbucks nearby. Keaau, HI has a Starbucks nearby.',
          sources: [{ title: 'Store locator', url: 'https://example.org/stores' }],
        }
      },
    })

  it('a throwing plan transport degrades to an abstention; the run still composes', async () => {
    const answer = await composeAnswerForRequest({
      intent: starbucksIntent(),
      queryText: starbucksQuery,
      rows: HI_ROWS,
      resolved: resolveAnswerGeographies(starbucksIntent(), null),
      provider: starbucksProvider(),
      research: true,
      stack: {
        decisions: {},
        jevTransport: NO_JEV,
        planTransport: THROWING_PLAN,
        verifyTransport: NULL_VERIFY,
      },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.verification?.jev).toBe('not-run')
    expect(answer?.verification?.wonder).toBe('not-run')
    expect(answer?.planObjections).toBeUndefined()
  })

  it('a throwing verify transport degrades to not-run; the verified answer still lands', async () => {
    const answer = await composeAnswerForRequest({
      intent: starbucksIntent(),
      queryText: starbucksQuery,
      rows: HI_ROWS,
      resolved: resolveAnswerGeographies(starbucksIntent(), null),
      provider: starbucksProvider(),
      research: true,
      stack: {
        decisions: {},
        jevTransport: NO_JEV,
        planTransport: NULL_PLAN,
        verifyTransport: THROWING_VERIFY,
      },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.length).toBeGreaterThan(0)
    // Degradation honesty: the failed bookend never labels the
    // answer Wonder-verified.
    expect(answer?.verification?.wonder).toBe('not-run')
  })
})

/* ------------------------------------------------------------------ */
/* Runner: the live failure at the seam the App calls                  */
/* ------------------------------------------------------------------ */

describe('runner: research failure through the full stack', () => {
  it('the Colorado question with the no-measures intent shape resolves to the degraded screen card', async () => {
    const coloradoIntent = intent({ geographies: ['CO'], metricKeys: [] })
    const answer = await composeAnswerForRequest({
      intent: coloradoIntent,
      queryText: COLORADO_Q,
      rows: CO_ROWS,
      // The live resolution runs against the loaded place index,
      // where a state sweep geography resolves (its rows are the
      // loaded scope). resolveAnswerGeographies with no index
      // marks the state unresolvable and the runner returns null
      // before the pipeline — a harness artifact, not the live
      // shape — so the resolved value is built directly.
      resolved: {
        zctas: new Set<string>(),
        scopePrefixes: [],
        unresolvable: false,
        unresolvedGeographies: [],
        geographyDisclosures: [],
        stateAggregates: [],
        countyGeographies: [],
      },
      provider: downProvider(),
      research: true,
      stack: {
        decisions: {},
        jevTransport: NO_JEV,
        planTransport: NULL_PLAN,
        verifyTransport: NULL_VERIFY,
      },
    })
    expect(answer?.status).toBe('verified')
    expect(answer?.places.length).toBeGreaterThan(0)
    expect(answer?.researchFailures).toContain('Nature and outdoors')
  })

  it('TOTAL-FAILURE CONTROL — research down, bookends throwing, Jev down: the honest note still lands', async () => {
    const placelessIntent = intent({ geographies: [], metricKeys: [] })
    const answer = await composeAnswerForRequest({
      intent: placelessIntent,
      queryText: SENTENCE_TWO,
      rows: CO_ROWS,
      resolved: resolveAnswerGeographies(placelessIntent, null),
      provider: downProvider(),
      research: true,
      stack: {
        decisions: {},
        jevTransport: NO_JEV,
        planTransport: THROWING_PLAN,
        verifyTransport: THROWING_VERIFY,
        flexibleTransport: async (): Promise<never> => {
          throw new Error('flexible route: HTTP 500')
        },
      },
    })
    expect(answer?.status).toBe('empty')
    expect(answer?.summary).toContain(DID_NOT_RETURN)
    expect(answer?.researchFailures).toContain('School quality')
    expect(answer?.noCensusMatch).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* Runner: flexible + Jev-loop patch controls                          */
/* ------------------------------------------------------------------ */

describe('runner: completion seams under failure (controls)', () => {
  it('CONTROL — a throwing flexible transport leaves the strict honest note standing', async () => {
    const placelessIntent = intent({ geographies: [], metricKeys: [] })
    const provider = createStubProvider({
      async research() {
        return {
          prose: 'Atlantis, GA is described as a quiet place with well-regarded schools.',
          sources: [{ title: 'Guide', url: 'https://example.org/guide' }],
        }
      },
    })
    const answer = await composeAnswerForRequest({
      intent: placelessIntent,
      queryText: SENTENCE_TWO,
      rows: CO_ROWS,
      resolved: resolveAnswerGeographies(placelessIntent, null),
      provider,
      research: true,
      stack: {
        decisions: {},
        jevTransport: NO_JEV,
        planTransport: NULL_PLAN,
        verifyTransport: NULL_VERIFY,
        flexibleTransport: async (): Promise<never> => {
          throw new Error('flexible route: HTTP 500')
        },
      },
    })
    expect(answer?.status).toBe('empty')
    expect(answer?.researchNamedPlaces).toContain('Atlantis, GA')
  })

  it('CONTROL — a research failure inside a Jev patch re-run leaves the first version standing', async () => {
    const rows: AreaRow[] = [
      { zcta: '30083', name: 'Stone Mountain, GA', metrics: { median_gross_rent: 1200 }, moes: { median_gross_rent: 60 } },
      { zcta: '77345', name: 'Kingwood, TX', metrics: { median_gross_rent: 1400 }, moes: { median_gross_rent: 70 } },
    ]
    let researchCalls = 0
    const provider = createStubProvider({
      async research() {
        researchCalls++
        if (researchCalls === 1) {
          return {
            prose: 'Stone Mountain, GA schools are rated above the state average in the cited directory.',
            sources: [{ title: 'School directory', url: 'https://example.org/schools' }],
          }
        }
        throw new Error('provider_down')
      },
    })
    let loopCalls = 0
    const loopAnswers = (noul: number): Record<string, JevAnswer> => ({
      'criterion:median_gross_rent': { type: 'noul', probability: noul },
      'criterion:schools': { type: 'noul', probability: noul },
      'criterion:cost_of_living': { type: 'noul', probability: noul },
      'criterion:coffee': { type: 'noul', probability: noul },
      relevance: { type: 'score', expected: 2, distribution: { '0': 0, '1': 0, '2': 1 } },
      completeness: { type: 'score', expected: 2, distribution: { '0': 0, '1': 0, '2': 1 } },
    })
    const placelessIntent = intent({ geographies: [], metricKeys: [] })
    const answer = await composeAnswerForRequest({
      intent: placelessIntent,
      queryText: SENTENCE_TWO,
      rows,
      resolved: resolveAnswerGeographies(placelessIntent, null),
      provider,
      research: true,
      stack: {
        decisions: {},
        planTransport: NULL_PLAN,
        verifyTransport: NULL_VERIFY,
        jevTransport: async ({ set }) => {
          if (set === 'J-BRANCH') {
            return {
              answers: {
                'branch-exists': { type: 'noul', probability: 0.1 },
                'branch-which': {
                  type: 'choice',
                  selected: 'none-of-these',
                  distribution: { transport: 0, 'school-level': 0, 'budget-anchor': 0, 'none-of-these': 1 },
                },
              } as Record<string, JevAnswer>,
            }
          }
          loopCalls++
          return { answers: loopAnswers(loopCalls === 1 ? 0.3 : 0.95) }
        },
      },
    })
    // ADAPTED (Lane A9 FM-11): the patch re-run's research stage
    // ends all-empty, so it is re-asked exactly once before the
    // failure settles — 3 research calls in total (the first
    // version's one, the re-run's two). The control's invariant is
    // unchanged: the first version stands.
    expect(researchCalls).toBe(3)
    expect(answer?.status).toBe('verified')
    expect(answer?.places.map((p) => p.name)).toContain('Stone Mountain, GA')
  })
})

/* ------------------------------------------------------------------ */
/* General lane: the nothing-in-hand terminal, by design               */
/* ------------------------------------------------------------------ */

describe('general lane: nothing-in-hand terminal (by design)', () => {
  it('a failed first draft rejects at this seam; the App renders the lane its own honest note, not the bare compose terminal', async () => {
    // The general lane holds no Census or research material, so
    // its total-failure terminal is the honest note by design. The
    // rejection is contained at this seam: App's handleGeneral
    // Request catch renders "the general answer could not be
    // reached just now" — a different, designed note from the
    // compose-failure terminal this file pins against.
    const provider = createStubProvider({
      async general() {
        throw new Error('provider_down')
      },
    })
    await expect(
      composeGeneralAnswer({
        queryText: 'How many marbles would it take to fill the moon?',
        deps: { provider, jevTransport: NO_JEV, session: { asked: false, wavedOff: false } },
      }),
    ).rejects.toThrow('provider_down')
  })
})
