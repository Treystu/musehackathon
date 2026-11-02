import { describe, expect, it, vi } from 'vitest'
import {
  arithmeticGap,
  checkArithmetic,
} from '../../src/core/ai/arithmetic-check'
import {
  GENERAL_ANSWER_LABEL,
  OPEN_INQUIRY_TEXT,
  candidateBridgesFor,
  dataIntentForHybrid,
  isInquiryWaveOff,
  resolveDomainClassification,
} from '../../src/core/ai/general'
import { canRun, validateIntent } from '../../src/core/ai/intent-schema'
import {
  GEN_ACCURACY_TARGET,
  INQUIRY_CONFIDENCE_THRESHOLD,
  INQUIRY_RELEVANCE_THRESHOLD,
  createHttpJevTransport,
  genQuestions,
  inquiryQuestions,
  type JevAnswer,
  type JevTransport,
} from '../../src/core/ai/jev-judgments'
import { createValidator } from '../../src/core/ai/validator'
import {
  createStubProvider,
  type MuseProvider,
  type ValidatedIntent,
} from '../../src/core/ai/provider'
import { parseGeneralReply } from '../../src/core/ai/meta-client'
import { handleGeneral } from '../../functions/api/muse/general'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import type { ProxyDeps } from '../../src/server/muse-proxy'
import { composeGeneralAnswer } from '../../src/ui/ai/general-runner'
import { dispatchFetch, type WorkerEnv } from '../../tools/worker-entry'

/**
 * P5 general lane pins (battery cluster E, hermetic): the three-way
 * classification and its guards, the deterministic arithmetic check,
 * the J-GEN loop (pass, patch, cap-with-precision-limit, Jev-down
 * degradation), beat 2's inquiry gate (specific only at both bars,
 * open otherwise, asked once), the E4/E6/E7/E8/E9 shapes, validator
 * separation at the route and reply level, and the general route's
 * worker registration. All transports are scripted stubs — no
 * network, no live model.
 */

function intent(partial: Partial<ValidatedIntent>): ValidatedIntent {
  return {
    mode: 'lookup',
    geographies: [],
    metricKeys: [],
    filters: [],
    clarificationNeeded: true,
    ...partial,
  }
}

const score = (expected: number): JevAnswer => ({ type: 'score', expected, distribution: {} })

/** A Jev transport answering J-GEN high and J-INQUIRY per the script. */
function jevTransport(script: {
  accuracy?: number
  relevance?: number
  choice?: string
  bridgeRelevance?: number
  bridgeConfidence?: number
}): JevTransport {
  return async ({ set, state }) => {
    if (set === 'J-GEN') {
      return {
        answers: {
          'gen-accuracy': score(script.accuracy ?? 0.99),
          'gen-relevance': score(script.relevance ?? 0.95),
        },
      }
    }
    if (set === 'J-INQUIRY') {
      const candidates = (state.candidates as { id: string }[]) ?? []
      const answers: Record<string, JevAnswer> = {
        'inquiry-choice': {
          type: 'choice',
          selected: script.choice ?? 'none',
          distribution: {},
        },
      }
      for (const c of candidates) {
        answers[`inquiry-relevance:${c.id}`] = score(script.bridgeRelevance ?? 0)
        answers[`inquiry-confidence:${c.id}`] = score(script.bridgeConfidence ?? 0)
      }
      return { answers }
    }
    return { answers: {} }
  }
}

const MARBLES =
  "About 2.7e25 marbles. The Moon's volume is 2.2e19 cubic metres and a marble's " +
  'volume is 5.2e-7 cubic metres (a marble 1 cm across, assumed), so ' +
  '2.2e19 / 5.2e-7 x 0.64 = 2.7e25 at a packing fraction of 0.64.'

function generalProvider(prose: string): MuseProvider {
  return createStubProvider({
    async general() {
      return { prose }
    },
  })
}

const FRESH_SESSION = { asked: false, wavedOff: false }

describe('three-way classification (plan C13)', () => {
  it('rides the intent contract: validateIntent carries a supplied domain and rejects one outside the enum', () => {
    const ok = validateIntent({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
      domain: 'off_domain',
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.intent.domain).toBe('off_domain')
    const bad = validateIntent({
      mode: 'lookup',
      geographies: [],
      metricKeys: [],
      filters: [],
      clarificationNeeded: true,
      domain: 'general',
    })
    expect(bad.ok).toBe(false)
  })

  it('E4: a current-events question classifies as data/research, never off-domain', () => {
    const resolved = resolveDomainClassification(
      intent({ domain: 'off_domain' }),
      'What happened in US housing news this week?',
    )
    expect(resolved.domain).toBe('data_with_gaps')
    expect(resolved.hybrid).toBe(false)
  })

  it('(a)-preference: a place+measure reading the model called off-domain is data', () => {
    const resolved = resolveDomainClassification(
      intent({
        domain: 'off_domain',
        geographies: ['Hilo, HI'],
        metricKeys: ['median_gross_rent'],
      }),
      'What is the median rent in Hilo?',
    )
    expect(resolved.domain).toBe('data_with_gaps')
    expect(resolved.hybrid).toBe(false)
  })

  it('ambiguous and field-less intents prefer the data class', () => {
    expect(resolveDomainClassification(intent({}), 'Where should I live?').domain).toBe(
      'data_with_gaps',
    )
    expect(
      resolveDomainClassification(intent({ domain: 'data_with_gaps' }), 'cheapest rent in Texas?')
        .domain,
    ).toBe('data_with_gaps')
  })

  it('safety is never created, widened, or overridden by the guards', () => {
    const resolved = resolveDomainClassification(
      intent({ domain: 'safety', geographies: ['Hilo, HI'] }),
      'What happened in US housing news this week?',
    )
    expect(resolved.domain).toBe('safety')
  })

  it('E6: a place inside an estimate question is a hybrid, and its data intent runs', () => {
    const parsed = intent({
      domain: 'off_domain',
      geographies: ['Hilo, HI'],
      metricKeys: ['average_household_size'],
    })
    const resolved = resolveDomainClassification(
      parsed,
      'How many marbles would fit in a typical house in Hilo?',
    )
    expect(resolved.domain).toBe('off_domain')
    expect(resolved.hybrid).toBe(true)
    const dataIntent = dataIntentForHybrid(parsed)
    expect(dataIntent.domain).toBe('data_with_gaps')
    expect(canRun(dataIntent)).toBe(true)
  })
})

describe('deterministic arithmetic check', () => {
  it('verifies a percentage-of and its rounding claim (E2 shape)', () => {
    const result = checkArithmetic(
      '420. 17% of 2,450 = 416.5, which rounds to 420 to the nearest ten.',
      "What's 17% of 2,450, rounded to the nearest ten?",
    )
    expect(result.passed).toBe(true)
    expect(result.checked).toBe(2)
  })

  it('verifies a Fermi chain within the rounded-input drift allowance (E1 shape)', () => {
    const result = checkArithmetic(MARBLES, 'How many marbles would it take to fill the moon?')
    expect(result.passed).toBe(true)
    expect(result.checked).toBe(1)
  })

  it('fails a wrong product and names the gap with the computed value', () => {
    const result = checkArithmetic('17% of 2,450 = 400, exactly.')
    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(arithmeticGap(result.failures[0]!)).toContain('416.5')
  })

  it('bare numerals with no stated computation are not judged (no fabricated derivation)', () => {
    const result = checkArithmetic('Jupiter has 95 moons.')
    expect(result.checked).toBe(0)
    expect(result.passed).toBe(true)
  })
})

describe('J-GEN judgment set (jev-judgments, additive)', () => {
  it('carries the owner bars as named constants', () => {
    expect(GEN_ACCURACY_TARGET).toBe(0.98)
    expect(INQUIRY_RELEVANCE_THRESHOLD).toBe(0.9)
    expect(INQUIRY_CONFIDENCE_THRESHOLD).toBe(0.9)
    expect(genQuestions().map((q) => q.id)).toEqual(['gen-accuracy', 'gen-relevance'])
    const inquiry = inquiryQuestions([{ id: 'schools', offerText: 'x' }])
    expect(inquiry[0]?.criteria).toContain('none')
  })

  it('the HTTP transport authors J-GEN and J-INQUIRY questions from state', async () => {
    const bodies: { set: string; questions: { id: string }[] }[] = []
    const transport = createHttpJevTransport(async (_url, init) => {
      bodies.push(JSON.parse((init as { body: string }).body))
      return new Response(JSON.stringify({ answers: {}, model: 'jev', latencyMs: 1 }), {
        status: 200,
      })
    })
    await transport({ set: 'J-GEN', state: { question: 'q', answerSummary: 'a' } })
    await transport({
      set: 'J-INQUIRY',
      state: { candidates: [{ id: 'schools', offerText: 'x' }] },
    })
    expect(bodies[0]?.questions.map((q) => q.id)).toEqual(['gen-accuracy', 'gen-relevance'])
    expect(bodies[1]?.questions.map((q) => q.id)).toContain('inquiry-relevance:schools')
  })
})

describe('general runner — beat 1 (J-GEN loop + arithmetic)', () => {
  it('E1: marbles ship a Fermi answer whose arithmetic verifies, with exactly one specific inquiry', async () => {
    const markAsked = vi.fn()
    const data = await composeGeneralAnswer({
      queryText: 'How many marbles would it take to fill the moon?',
      deps: {
        provider: generalProvider(MARBLES),
        jevTransport: jevTransport({ choice: 'place-space', bridgeRelevance: 0.95, bridgeConfidence: 0.93 }),
        session: FRESH_SESSION,
        markAsked,
      },
    })
    expect(data.proseClass).toBe('general')
    expect(data.label).toBe(GENERAL_ANSWER_LABEL)
    expect(data.text).toBe(MARBLES)
    expect(data.arithmetic.passed).toBe(true)
    expect(data.arithmetic.checked).toBe(1)
    expect(data.jev).toMatchObject({ ran: true, roundsUsed: 0 })
    expect(data.precisionLimit).toBeNull()
    expect(data.inquiry?.kind).toBe('specific')
    expect(data.inquiry?.bridge?.id).toBe('place-space')
    expect(markAsked).toHaveBeenCalledTimes(1)
  })

  it('E2: exact math ships 420, arithmetic-checked', async () => {
    const data = await composeGeneralAnswer({
      queryText: "What's 17% of 2,450, rounded to the nearest ten?",
      deps: {
        provider: generalProvider(
          '420. 17% of 2,450 = 416.5, which rounds to 420 to the nearest ten.',
        ),
        jevTransport: jevTransport({}),
        session: FRESH_SESSION,
        markAsked: vi.fn(),
      },
    })
    expect(data.text).toContain('420')
    expect(data.arithmetic.passed).toBe(true)
    expect(data.arithmetic.checked).toBe(2)
  })

  it('a failed arithmetic check is a named gap fed to the loop, and the patched version ships', async () => {
    const revisions: string[] = []
    const provider = createStubProvider({
      async general(req) {
        if (req.revision) {
          revisions.push(req.revision.gaps.join('; '))
          return { prose: '420. 17% of 2,450 = 416.5, which rounds to 420 to the nearest ten.' }
        }
        return { prose: '400. 17% of 2,450 = 400.' }
      },
    })
    const data = await composeGeneralAnswer({
      queryText: "What's 17% of 2,450, rounded to the nearest ten?",
      deps: {
        provider,
        jevTransport: jevTransport({}),
        session: FRESH_SESSION,
        markAsked: vi.fn(),
      },
    })
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toContain('Arithmetic check failed')
    expect(data.text).toContain('420')
    expect(data.arithmetic.passed).toBe(true)
    expect(data.jev.roundsUsed).toBe(1)
  })

  it('below bar after the round cap ships with its precision limit stated', async () => {
    const provider = createStubProvider({
      async general() {
        return { prose: 'Somewhere around a lot of marbles, probably.' }
      },
    })
    const data = await composeGeneralAnswer({
      queryText: 'How many marbles would it take to fill the moon?',
      deps: {
        provider,
        jevTransport: jevTransport({ accuracy: 0.4, relevance: 0.4 }),
        session: { asked: true, wavedOff: false },
        markAsked: vi.fn(),
      },
    })
    expect(data.jev.roundsUsed).toBeGreaterThan(0)
    expect(data.precisionLimit).toContain('Precision limit')
    expect(data.inquiry).toBeNull()
  })

  it('Jev route unavailable: the answer still ships, arithmetic still runs, no Jev claim', async () => {
    const down: JevTransport = async () => {
      throw new Error('jev route: HTTP 503')
    }
    const data = await composeGeneralAnswer({
      queryText: 'How many marbles would it take to fill the moon?',
      deps: {
        provider: generalProvider(MARBLES),
        jevTransport: down,
        session: FRESH_SESSION,
        markAsked: vi.fn(),
      },
    })
    expect(data.text).toBe(MARBLES)
    expect(data.jev.ran).toBe(false)
    expect(data.jev.accuracy).toBeNull()
    expect(data.arithmetic.passed).toBe(true)
    // Beat 2 degrades to the open question only — no scored bridge.
    expect(data.inquiry?.kind).toBe('open')
    expect(data.inquiry?.text).toBe(OPEN_INQUIRY_TEXT)
  })
})

describe('general runner — beat 2 (inquiry gate)', () => {
  it('E8: below-bar scores render the open question only — no specific bridge', async () => {
    const data = await composeGeneralAnswer({
      queryText: 'How many moons does Jupiter have?',
      deps: {
        provider: generalProvider('95 moons. Jupiter has 95 known moons.'),
        jevTransport: jevTransport({
          choice: 'place-decision',
          bridgeRelevance: 0.4,
          bridgeConfidence: 0.3,
        }),
        session: FRESH_SESSION,
        markAsked: vi.fn(),
      },
    })
    expect(data.inquiry?.kind).toBe('open')
    expect(data.inquiry?.bridge).toBeUndefined()
    expect(data.inquiry?.text).toBe(OPEN_INQUIRY_TEXT)
    // The no-tie-in question's candidate pool carries no topical bridge.
    expect(candidateBridgesFor('How many moons does Jupiter have?').map((c) => c.id)).toEqual([
      'place-decision',
    ])
  })

  it("E9: a waved-off (or already-asked) session gets no second inquiry", async () => {
    const data = await composeGeneralAnswer({
      queryText: 'How many marbles would it take to fill the moon?',
      deps: {
        provider: generalProvider(MARBLES),
        jevTransport: jevTransport({ choice: 'place-space', bridgeRelevance: 0.99, bridgeConfidence: 0.99 }),
        session: { asked: true, wavedOff: true },
        markAsked: vi.fn(),
      },
    })
    expect(data.inquiry).toBeNull()
  })

  it('E7 shape: a substantive reply is not a wave-off and routes as a first-class request', () => {
    expect(isInquiryWaveOff("honestly I'm thinking about moving somewhere quieter")).toBe(false)
    expect(isInquiryWaveOff('Tell me about Hilo')).toBe(false)
    expect(isInquiryWaveOff('nope, just curious')).toBe(true)
    expect(isInquiryWaveOff('No thanks')).toBe(true)
  })
})

describe('validator separation (explicit)', () => {
  it('a general answer containing numerals is NOT blocked by invented_numeral', () => {
    // The figure validator, given no retrieved figures, refuses this
    // prose outright — that refusal is correct for DATA prose and
    // must have no jurisdiction over the general class.
    const verdict = createValidator().validate(MARBLES, [])
    expect(verdict.pass).toBe(false)
    if (!verdict.pass) expect(verdict.failure).toBe('invented_numeral')
    // The general route never runs it: the same prose returns 200.
    return expect(
      handleGeneral(
        { method: 'POST', path: '/api/muse/general', body: { queryText: 'marbles?' }, clientId: 't' },
        generalDeps(generalProvider(MARBLES)),
      ),
    ).resolves.toMatchObject({ status: 200, body: { prose: MARBLES } })
  })

  it('the general reply shape carries prose only — no figures, no Census label', () => {
    const reply = parseGeneralReply({ prose: MARBLES })
    expect(reply).toEqual({ prose: MARBLES })
    expect(GENERAL_ANSWER_LABEL).toContain("model's own answer")
  })
})

function generalDeps(provider: MuseProvider): ProxyDeps {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider,
    allowedModels: ['muse-spark-1.3'],
    waitOut: { breakerWaitMs: 0, pollMs: 0, retryDelaysMs: [] },
  }
}

describe('general route registration (worker entry)', () => {
  it('POST /api/muse/general reaches the general handler: keyless provider_down shape', async () => {
    const env = {
      ASSETS: {
        fetch: async () =>
          new Response('<html><body>app</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      },
    } as WorkerEnv
    const res = await dispatchFetch(
      new Request('https://portal.example/api/muse/general', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryText: 'How many marbles would it take to fill the moon?' }),
      }),
      env,
      { waitUntil: () => {} },
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'provider_down',
      detail: 'no shared key configured',
    })
  })
})
