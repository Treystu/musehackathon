import { describe, expect, it } from 'vitest'
import {
  JEV_BRANCH_FIRE,
  JEV_CRITERION_PASS,
  JEV_MODEL,
  JEV_PHRASE_PASS,
  JEV_SCORE_PASS,
  buildSystemOneRequest,
  loopQuestionsFromLabels,
  mapSystemOneResponse,
} from '../../src/core/ai/jev-judgments'
import { createJevTransport, JevUnavailableError } from '../../src/server/jev-client'
import { handleJev } from '../../functions/api/muse/jev'

/**
 * C3 Jev service: judgment sets are data with exact shapes, the
 * transport maps the documented System One wire format by question
 * id, and the route degrades typed when no key is provisioned.
 */
describe('jev judgment sets', () => {
  it('carries the plan thresholds as named constants', () => {
    expect(JEV_CRITERION_PASS).toBe(0.8)
    expect(JEV_SCORE_PASS).toBe(1.5)
    expect(JEV_BRANCH_FIRE).toBe(0.75)
    expect(JEV_PHRASE_PASS).toBe(0.8)
    expect(JEV_MODEL).toBe('jev-latest')
  })

  it('J-LOOP builds one noul per criterion plus relevance and completeness scores', () => {
    const qs = loopQuestionsFromLabels(['good schools', 'few fast food places'])
    expect(qs.map((q) => q.id)).toEqual(['criterion_0', 'criterion_1', 'relevance', 'completeness'])
    expect(qs[0]).toEqual({
      id: 'criterion_0',
      type: 'noul',
      instructions:
        'Criterion good schools is addressed in the answer with evidence ' +
        '(a figure, a cited finding, or an explicit not-measurable label).',
    })
    expect(qs[2]?.type).toBe('score')
    expect(qs[2]?.criteria).toEqual([
      'answers a different question',
      'partially addresses the question asked',
      'directly and fully addresses the question asked',
    ])
    expect(qs[3]?.criteria).toEqual([
      'major stated criteria missing',
      'all criteria present but thin in places',
      'every stated criterion fleshed out with its evidence',
    ])
  })

  it('builds the documented System One wire shape, questions keyed by name', () => {
    const req = buildSystemOneRequest('J-BRANCH', { question: 'q' })
    expect(req.model).toBe('jev-latest')
    expect(Object.keys(req.questions)).toEqual(['branch_exists', 'branch_kind'])
    expect(req.questions.branch_kind?.type).toBe('choice')
    expect(Object.keys(req.questions.branch_kind?.criteria as Record<string, string>)).toEqual([
      'transport_mode',
      'school_level',
      'budget_anchor',
      'none_of_these',
    ])
    const phrase = buildSystemOneRequest('J-PHRASE', { drafted: 'x' })
    expect(phrase.questions.phrase_specific?.instructions).toContain('clearly and specifically relevant')
  })

  it('maps wire answers back by id and drops malformed answers', () => {
    const qs = loopQuestionsFromLabels(['schools'])
    const mapped = mapSystemOneResponse(
      {
        model: 'jev-1.14.0',
        answers: {
          criterion_0: { type: 'noul', noul: 0.93 },
          relevance: { type: 'score', score: 1.7, probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 } },
          completeness: { type: 'score', score: 'high' },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      qs,
      42,
    )
    expect(mapped?.model).toBe('jev-1.14.0')
    expect(mapped?.latencyMs).toBe(42)
    expect(mapped?.answers.criterion_0).toEqual({ type: 'noul', probability: 0.93 })
    expect(mapped?.answers.relevance).toEqual({
      type: 'score',
      expected: 1.7,
      distribution: { '0': 0.1, '1': 0.1, '2': 0.8 },
    })
    expect(mapped?.answers.completeness).toBeUndefined()
    expect(mapSystemOneResponse({ nope: true }, qs, 1)).toBeNull()
  })
})

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

describe('jev transport', () => {
  it('posts to /v1/systemone with bearer auth and maps the reply', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenBody: Record<string, unknown> = {}
    const fetchImpl = (async (url: unknown, init: { headers?: Record<string, string>; body?: string }) => {
      seenUrl = String(url)
      seenAuth = init.headers?.authorization ?? ''
      seenBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      return new Response(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: { phrase_specific: { type: 'noul', noul: 0.88 } },
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const transport = createJevTransport({ apiKey: 'test-key', fetchImpl, now: () => 100 })
    const out = await transport.evaluate('J-PHRASE', { drafted: 'Quick question?' })
    expect(seenUrl).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seenAuth).toBe('Bearer test-key')
    expect((seenBody.questions as Record<string, unknown>).phrase_specific).toBeDefined()
    expect(out.answers.phrase_specific).toEqual({ type: 'noul', probability: 0.88 })
  })

  it('an upstream failure is the typed unavailable, with no body leak', async () => {
    const transport = createJevTransport({
      apiKey: 'test-key',
      fetchImpl: stubFetch({ detail: 'secret upstream detail' }, 500),
    })
    await expect(transport.evaluate('J-PHRASE', {})).rejects.toBeInstanceOf(JevUnavailableError)
  })
})

describe('jev route', () => {
  const req = (body: unknown) => ({ method: 'POST', path: '/api/muse/jev', body })

  it('absent key answers the typed unavailable, never a 500', async () => {
    const r = await handleJev(req({ set: 'J-PHRASE', state: { drafted: 'x' } }), { transport: null })
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: 'jev_unavailable' })
  })

  it('rejects unknown sets and malformed state as shape_invalid', async () => {
    const transport = createJevTransport({ apiKey: 'k', fetchImpl: stubFetch({}) })
    for (const body of [{ set: 'J-NOPE', state: {} }, { set: 'J-LOOP' }, { set: 'J-LOOP', state: 42 }]) {
      const r = await handleJev(req(body), { transport })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('shape_invalid')
    }
  })

  it('returns typed answers with model and latency', async () => {
    const transport = {
      async evaluate() {
        return {
          answers: { branch_exists: { type: 'noul' as const, probability: 0.9 } },
          model: 'jev-1.14.0',
          latencyMs: 12,
        }
      },
    }
    const r = await handleJev(req({ set: 'J-BRANCH', state: { question: 'q' } }), { transport })
    expect(r.status).toBe(200)
    expect(r.body.model).toBe('jev-1.14.0')
    expect(r.body.latencyMs).toBe(12)
    expect((r.body.answers as Record<string, unknown>).branch_exists).toEqual({
      type: 'noul',
      probability: 0.9,
    })
  })

  it('a transport failure degrades typed, independent of any Muse breaker', async () => {
    const transport = {
      async evaluate(): Promise<never> {
        throw new JevUnavailableError()
      },
    }
    const r = await handleJev(req({ set: 'J-LOOP', state: {}, criteria: ['schools'] }), { transport })
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'jev_unavailable' })
  })
})
