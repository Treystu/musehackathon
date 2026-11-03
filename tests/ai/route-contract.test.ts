import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { PROXY_ALLOWED_MODELS, RESEARCH_QUERY_MAX_CHARS } from '../../src/core/ai/meta-client'
import {
  createStubProvider,
  createStubStageProvider,
  type StageChatProvider,
} from '../../src/core/ai/provider'
import {
  buildPlanPacket,
  buildVerifyPacket,
  createHttpBookendTransports,
  wonderLabelFor,
} from '../../src/core/ai/bookends'
import {
  conformFlexibleDraftRequest,
  createHttpFlexibleTransport,
  FLEXIBLE_MAX_CLAIM_CHARS,
  FLEXIBLE_MAX_CLAIMS,
  FLEXIBLE_MAX_SOURCES,
  FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM,
  type FlexibleDraftRequest,
} from '../../src/core/ai/flexible'
import {
  composeFlexibleCompletion,
  flexibleDraftRequestFor,
} from '../../src/ui/ai/flexible-runner'
import { composeResearchQueryText } from '../../src/ui/ai/answer-runner'
import { decomposeResearchCriteria, type ComposedAnswer } from '../../src/core/ai/answer'
import { isProximityCriterion, proximityFocus } from '../../src/core/ai/nearby'
import { handlePlan } from '../../functions/api/muse/plan'
import { handleVerify } from '../../functions/api/muse/verify'
import { handleFlexible } from '../../functions/api/muse/flexible'
import { handleResearch } from '../../functions/api/muse/research'
import type { ProxyDeps, ProxyReply } from '../../src/server/muse-proxy'

/**
 * Route-contract cure (2026-11-03): the client/route wire
 * contracts, pinned end to end. Before this cure, hermetic
 * bisection measured: the plan route refused every
 * conversational-stack call (the client sent subsetSummary +
 * intent.metricKeys; the route requires subset + intent.measures)
 * and its 200 replies parsed to null in the client's verdict
 * parsers (replies carry `outcome`, parsers read `verdict`); the
 * verify route refused every stack call on answerText / place
 * objects / evidence field names; the flexible route refused the
 * research-rich packets a zero-match run gathers (sources, claims,
 * and per-claim source lists past its caps); and iterative
 * research passes outgrew the research route's 500-char queryText
 * ceiling at the runner's assemblies. The routes keep their
 * strict contracts — the cures are all at the construction sites,
 * and the last block below pins that the routes still refuse the
 * old shapes.
 */
function deps(stage?: Partial<StageChatProvider>): ProxyDeps {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(),
    stageProvider: stage ? createStubStageProvider(stage) : undefined,
    allowedModels: [...PROXY_ALLOWED_MODELS],
    waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [] },
  }
}

/** A fetcher that dispatches to the real route handlers, in-process. */
function routeFetcher(d: ProxyDeps) {
  const handlers: Record<string, (req: never, deps: ProxyDeps) => Promise<ProxyReply>> = {
    '/api/muse/plan': handlePlan as never,
    '/api/muse/verify': handleVerify as never,
    '/api/muse/flexible': handleFlexible as never,
  }
  return (async (url: unknown, init?: { body?: string }) => {
    const path = String(url)
    const handler = handlers[path]
    if (!handler) return new Response('{}', { status: 404 })
    const reply = await handler(
      { method: 'POST', path, body: JSON.parse(init?.body ?? '{}'), clientId: 'c1' } as never,
      d,
    )
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const stageReturning = (text: string, model: string) => ({
  async stageChat() {
    return { text, model }
  },
})

/** The plan packet exactly as answer-runner.ts builds it. */
function runnerPlanPacket() {
  return buildPlanPacket({
    question: 'Where can I move around Nashville that has good schools and high wages?',
    intent: { mode: 'sweep_filter', geographies: ['Nashville, TN'], metricKeys: ['median_household_income'] },
    criteria: [
      { kind: 'census', text: 'median_household_income' },
      { kind: 'research', text: 'School quality' },
    ],
    subsetSummary: { count: 10, ranges: [] },
    decisions: {},
  })
}

/** The verify packet exactly as answer-runner.ts builds it. */
function runnerVerifyPacket() {
  return buildVerifyPacket({
    summary: 'The places named here are shown with their Census figures for the measures in this request.',
    places: [{ name: 'Nashville-Davidson, TN', figures: [{ key: 'median_household_income', value: 53034 }] }],
    evidence: [{ criterion: 'School quality', status: 'met', detail: 'Served by the cited sources shown with the places.' }],
    sources: [{ title: 'District rankings', url: 'https://example.org/schools' }],
    verifySummary: 'status verified; 1 places; 0 verify failures',
    placeDisplayLimit: 10,
  })
}

describe('plan bookend: the client packet and the route, end to end', () => {
  it('the route accepts the shipped client packet and settles a verdict', async () => {
    const d = deps(stageReturning('{"verdict":"sound","objections":[]}', 'muse-wonder-1.0'))
    const r = await handlePlan(
      { method: 'POST', path: '/api/muse/plan', body: runnerPlanPacket(), clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
    expect(r.body.outcome).toBe('sound')
  })

  it('the HTTP transport returns the parsed verdict, not null', async () => {
    const d = deps(stageReturning('{"verdict":"sound","objections":[]}', 'muse-wonder-1.0'))
    const transports = createHttpBookendTransports(routeFetcher(d))
    await expect(transports.plan(runnerPlanPacket())).resolves.toEqual({
      verdict: 'sound',
      objections: [],
    })
  })

  it('an unsound route verdict reaches the client with its objections', async () => {
    const d = deps(
      stageReturning(
        '{"verdict":"unsound","objections":[{"code":"missing_criterion","detail":"fast food not decomposed"}]}',
        'muse-wonder-1.0',
      ),
    )
    const transports = createHttpBookendTransports(routeFetcher(d))
    await expect(transports.plan(runnerPlanPacket())).resolves.toEqual({
      verdict: 'unsound',
      objections: [{ code: 'missing_criterion', detail: 'fast food not decomposed' }],
    })
  })
})

describe('verify bookend: the client packet and the route, end to end', () => {
  it('the route accepts the shipped client packet and labels verified', async () => {
    const d = deps(stageReturning('{"verdict":"verified","concerns":[]}', 'muse-wonder-1.0'))
    const r = await handleVerify(
      { method: 'POST', path: '/api/muse/verify', body: runnerVerifyPacket(), clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
    expect(r.body.wonder).toBe('verified')
  })

  it('the HTTP transport returns the parsed verdict and the Wonder label follows', async () => {
    const d = deps(stageReturning('{"verdict":"verified","concerns":[]}', 'muse-wonder-1.0'))
    const transports = createHttpBookendTransports(routeFetcher(d))
    const verdict = await transports.verify(runnerVerifyPacket())
    expect(verdict).toEqual({ verdict: 'verified', concerns: [] })
    expect(wonderLabelFor(verdict)).toBe('verified')
  })

  it('a concerns route outcome reaches the client with the concerns label', async () => {
    const d = deps(
      stageReturning(
        '{"verdict":"concerns","concerns":[{"kind":"factual","detail":"rent figure mismatch"}]}',
        'muse-wonder-1.0',
      ),
    )
    const transports = createHttpBookendTransports(routeFetcher(d))
    const verdict = await transports.verify(runnerVerifyPacket())
    expect(verdict).toEqual({
      verdict: 'concerns',
      concerns: [{ kind: 'factual', detail: 'rent figure mismatch' }],
    })
    expect(wonderLabelFor(verdict)).toBe('concerns')
  })

  it('a not_verified outcome is carried faithfully (its label is not-run by design)', async () => {
    const d = deps(
      stageReturning(
        '{"verdict":"not_verified","concerns":[{"kind":"factual","detail":"rent figure mismatch"}]}',
        'muse-wonder-1.0',
      ),
    )
    const transports = createHttpBookendTransports(routeFetcher(d))
    const verdict = await transports.verify(runnerVerifyPacket())
    expect(verdict).toEqual({
      verdict: 'not_verified',
      concerns: [{ kind: 'factual', detail: 'rent figure mismatch' }],
    })
    // bookends.ts wonderLabelFor, documented: not_verified = not-run.
    expect(wonderLabelFor(verdict)).toBe('not-run')
  })
})

/* ------------------------------------------------------------------ */
/* Flexible: the zero-match engagement                                 */
/* ------------------------------------------------------------------ */

const SENTENCE_1 = 'What city has the best schools but also has the fewest fast food restaurants?'
const srcAt = (i: number) => ({ title: `Source ${i}`, url: `https://example.org/s${i}` })

/**
 * A zero-match strict answer carrying research-RICH gathered
 * material — the shape that bisected to the flexible route's 400:
 * 16 deduped sources across two passes, 14 claims (13 short ones
 * citing 13 source URLs each, plus one 700-char run-on riding
 * early in gathering order so the conformance split is exercised
 * inside the claim cap, not beyond it).
 */
function richZeroMatchAnswer(over: Record<string, unknown> = {}): ComposedAnswer {
  const longClaim = Array.from({ length: 140 }, () => 'word').join(' ')
  const shortClaim = (i: number) => ({
    text: `Finding ${i}: a cited sentence about school quality near the named places.`,
    sourceUrls: Array.from({ length: 13 }, (_, j) => `https://example.org/s${j}`),
  })
  const claims = [
    shortClaim(0),
    { text: longClaim, sourceUrls: ['https://example.org/s0'] },
    ...Array.from({ length: 12 }, (_, i) => shortClaim(i + 1)),
  ]
  return {
    status: 'empty',
    summary: 'Research for the stated criteria did not produce a place that could be shown here.',
    places: [],
    generalClaims: claims,
    sources: Array.from({ length: 16 }, (_, i) => srcAt(i)),
    criterionEvidence: [],
    researchCriteria: [
      { id: 'schools', label: 'School quality' },
      { id: 'fast-food', label: 'Fast food restaurants' },
    ],
    researchNamedPlaces: ['Stone Mountain, GA', 'Kingwood, TX'],
    unresolvedCandidates: ['Stone Mountain, GA', 'Kingwood, TX'],
    noCensusMatch: true,
    failures: [],
    ...over,
  } as unknown as ComposedAnswer
}

const draftStageReturning = (draft: unknown) =>
  stageReturning(JSON.stringify(draft), 'muse-spark-1.3')

describe('flexible lane: the zero-match engagement', () => {
  it('construction conforms the research-rich packet to the route caps', () => {
    const request = flexibleDraftRequestFor({
      queryText: SENTENCE_1,
      strictAnswer: richZeroMatchAnswer(),
    })
    expect(request.sources.length).toBe(FLEXIBLE_MAX_SOURCES)
    expect(request.claims.length).toBeLessThanOrEqual(FLEXIBLE_MAX_CLAIMS)
    for (const c of request.claims) {
      expect(c.text.length).toBeGreaterThan(0)
      expect(c.text.length).toBeLessThanOrEqual(FLEXIBLE_MAX_CLAIM_CHARS)
      expect(c.sourceUrls.length).toBeLessThanOrEqual(FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM)
    }
    // The 700-char run-on was split, not dropped: its words all ride.
    const rejoined = request.claims.map((c) => c.text).join(' ')
    expect(rejoined.split(' ').filter((w) => w === 'word').length).toBe(140)
  })

  it('the conformed zero-match request engages the route through the real transport', async () => {
    const draft = {
      prose:
        'Stone Mountain and Kingwood were named in the cited research for the stated criteria; ' +
        'neither could be matched to Census data in the loaded dataset.',
      places: [
        { name: 'Stone Mountain, GA', basis: 'research', note: 'Named for school quality in the cited research.', figures: [] },
        { name: 'Kingwood, TX', basis: 'research', note: 'Named for school quality in the cited research.', figures: [] },
      ],
      figures: [],
    }
    const d = deps(draftStageReturning(draft))
    const transport = createHttpFlexibleTransport(routeFetcher(d))
    const request = flexibleDraftRequestFor({
      queryText: SENTENCE_1,
      strictAnswer: richZeroMatchAnswer(),
    })
    await expect(transport(request)).resolves.toEqual(draft)
  })

  it('the sentence-1 shape completes end to end: draft -> validator -> labeled completion', async () => {
    const draft = {
      prose:
        'Stone Mountain and Kingwood were named in the cited research for the stated criteria; ' +
        'neither could be matched to Census data in the loaded dataset.',
      places: [
        { name: 'Stone Mountain, GA', basis: 'research', note: 'Named for school quality in the cited research.', figures: [] },
        { name: 'Kingwood, TX', basis: 'research', note: 'Named for school quality in the cited research.', figures: [] },
      ],
      figures: [],
    }
    const d = deps(draftStageReturning(draft))
    const strictAnswer = richZeroMatchAnswer()
    const outcome = await composeFlexibleCompletion({
      queryText: SENTENCE_1,
      strictAnswer,
      rows: [],
      criteria: [],
      deps: {
        flexibleTransport: createHttpFlexibleTransport(routeFetcher(d)),
        jevTransport: (async () => {
          throw new Error('jev loop not under test here')
        }) as never,
        verifyTransport: async () => null,
      },
    })
    expect(outcome).not.toBeNull()
    expect(outcome!.flexible.places.map((p) => p.name)).toEqual(['Stone Mountain, GA', 'Kingwood, TX'])
    expect(outcome!.flexible.places.every((p) => p.evidenceClass === 'research_named')).toBe(true)
    expect(outcome!.verification.wonder).toBe('not-run')
  })

  it('the zero-named variant completes on model-labelled places', async () => {
    const draft = {
      prose:
        'No place was named in the cited research for the stated criteria. ' +
        'The places below are offered from general knowledge and labelled as such.',
      places: [{ name: 'Exampleton', basis: 'model', note: 'Offered from general knowledge.', figures: [] }],
      figures: [],
    }
    const d = deps(draftStageReturning(draft))
    const strictAnswer = richZeroMatchAnswer({
      researchNamedPlaces: [],
      unresolvedCandidates: [],
    })
    const outcome = await composeFlexibleCompletion({
      queryText: SENTENCE_1,
      strictAnswer,
      rows: [],
      criteria: [],
      deps: {
        flexibleTransport: createHttpFlexibleTransport(routeFetcher(d)),
        jevTransport: (async () => {
          throw new Error('jev loop not under test here')
        }) as never,
        verifyTransport: async () => null,
      },
    })
    expect(outcome).not.toBeNull()
    expect(outcome!.flexible.places[0]!.evidenceClass).toBe('model_knowledge')
  })

  it('the all-empty zero-match request engages (no material at all)', async () => {
    const d = deps(draftStageReturning({ prose: 'A completion.', places: [], figures: [] }))
    const transport = createHttpFlexibleTransport(routeFetcher(d))
    const request = flexibleDraftRequestFor({
      queryText: SENTENCE_1,
      strictAnswer: richZeroMatchAnswer({
        generalClaims: [],
        sources: [],
        researchNamedPlaces: [],
        unresolvedCandidates: [],
      }),
    })
    await expect(transport(request)).resolves.toEqual({ prose: 'A completion.', places: [], figures: [] })
  })

  it('conformance splits an over-cap claim at sentence boundaries, carrying every word', () => {
    const s1 = `${'alpha '.repeat(89)}alpha.`
    const s2 = `${'beta '.repeat(89)}beta.`
    const request: FlexibleDraftRequest = {
      question: 'q',
      criteria: [],
      researchPlaces: [],
      claims: [{ text: `${s1} ${s2}`, sourceUrls: ['https://example.org/a'] }],
      sources: [],
    }
    const conformed = conformFlexibleDraftRequest(request)
    expect(conformed.claims.map((c) => c.text)).toEqual([s1, s2])
  })

  it('conformance trims a revision within the route caps', () => {
    const request: FlexibleDraftRequest = {
      question: 'q',
      criteria: [],
      researchPlaces: [],
      claims: [],
      sources: [],
      revision: {
        draftText: Array.from({ length: 2000 }, () => 'draft').join(' '),
        gaps: Array.from({ length: 10 }, (_, i) => `gap ${i} ${'detail '.repeat(60)}`),
      },
    }
    const conformed = conformFlexibleDraftRequest(request)
    expect(conformed.revision!.draftText.length).toBeLessThanOrEqual(6000)
    expect(conformed.revision!.gaps.length).toBe(8)
    for (const g of conformed.revision!.gaps) expect(g.length).toBeLessThanOrEqual(300)
  })
})

/* ------------------------------------------------------------------ */
/* Research queryText ceiling                                          */
/* ------------------------------------------------------------------ */

describe('research queryText: composed within the ceiling at the assemblies', () => {
  const question = 'Where in Hilo has the best schools and affordable housing, with a Starbucks nearby?'
  const proximity = decomposeResearchCriteria(question).find((c) => isProximityCriterion(c.id))
  const focus = proximity ? proximityFocus(proximity.id, undefined).focusText : ''
  const gaps = [
    'The answer does not state whether the coffee places are inside Hilo itself or elsewhere on the island',
    'The answer gives no per-mode breakdown for reaching the coffee places it names',
  ]

  it('the focused assembly is unchanged when it fits (the pinned runner shape)', () => {
    const composed = composeResearchQueryText(question, [focus])
    expect(composed.trimmed).toBe(false)
    expect(composed.text).toBe(`${question} ${focus}`)
    expect(composed.text.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
  })

  it('iterative patch assemblies stay within the ceiling across rounds', () => {
    const base = composeResearchQueryText(question, [focus])
    const round1 = composeResearchQueryText(base.text, [`Address these gaps: ${gaps.join('; ')}`])
    expect(round1.text.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    expect(round1.trimmed).toBe(true)
    expect(round1.text.startsWith(question)).toBe(true)
    const round2 = composeResearchQueryText(round1.text, [`Address these gaps: ${gaps.join('; ')}`])
    expect(round2.text.length).toBeLessThanOrEqual(RESEARCH_QUERY_MAX_CHARS)
    expect(round2.text.startsWith(question)).toBe(true)
  })

  it('an addition with no useful room is skipped, the question intact', () => {
    const longQuestion = `${'q'.repeat(479)}?`
    const composed = composeResearchQueryText(longQuestion, [focus])
    expect(composed.text).toBe(longQuestion)
    expect(composed.trimmed).toBe(true)
  })

  it('the composed patch text passes the research route shape gate', async () => {
    const base = composeResearchQueryText(question, [focus])
    const round1 = composeResearchQueryText(base.text, [`Address these gaps: ${gaps.join('; ')}`])
    const d: ProxyDeps = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider({
        async research() {
          return {
            prose: 'Grounded findings about Hilo schools and coffee.',
            sources: [{ title: 'State report', url: 'https://example.org/x' }],
            searchCalls: 1,
          }
        },
      }),
      allowedModels: [...PROXY_ALLOWED_MODELS],
      waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [] },
    }
    const r = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: round1.text, places: [] }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
  })
})

/* ------------------------------------------------------------------ */
/* The routes keep their strict contracts                              */
/* ------------------------------------------------------------------ */

describe('the routes still refuse the uncured shapes', () => {
  it('plan refuses the pre-cure packet shape (subsetSummary, no measures)', async () => {
    const d = deps(stageReturning('{"verdict":"sound","objections":[]}', 'muse-wonder-1.0'))
    const oldShape = {
      question: 'q',
      intent: { mode: 'lookup', geographies: [], metricKeys: [] },
      criteria: [],
      subsetSummary: { count: 0, ranges: [] },
      decisions: {},
    }
    const r = await handlePlan({ method: 'POST', path: '/api/muse/plan', body: oldShape, clientId: 'c1' }, d)
    expect(r.status).toBe(400)
  })

  it('verify refuses the pre-cure packet shape (summary, place objects, evidence)', async () => {
    const d = deps(stageReturning('{"verdict":"verified","concerns":[]}', 'muse-wonder-1.0'))
    const oldShape = {
      summary: 's',
      places: [{ name: 'Hilo', figures: [] }],
      evidence: [],
      sources: [],
      verifySummary: 'v',
    }
    const r = await handleVerify({ method: 'POST', path: '/api/muse/verify', body: oldShape, clientId: 'c1' }, d)
    expect(r.status).toBe(400)
  })

  it('flexible refuses an unconformed over-cap packet', async () => {
    const d = deps(draftStageReturning({ prose: 'x', places: [], figures: [] }))
    const overCap = {
      question: 'q',
      criteria: [],
      researchPlaces: [],
      claims: [],
      sources: Array.from({ length: 13 }, (_, i) => srcAt(i)),
    }
    const r = await handleFlexible(
      { method: 'POST', path: '/api/muse/flexible', body: overCap, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(400)
  })
})
