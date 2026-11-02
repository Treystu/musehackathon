import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { MUSE_WONDER_MODEL, PROXY_ALLOWED_MODELS, createMetaDirectProvider } from '../../src/core/ai/meta-client'
import {
  createStubProvider,
  createStubStageProvider,
  type StageChatProvider,
} from '../../src/core/ai/provider'
import {
  bookendCountersSnapshot,
  resetBookendCountersForTests,
} from '../../src/core/ai/bookend-counters'
import { handlePlan, withStageTimeout, PLAN_SETTLE_MICRO_USD } from '../../functions/api/muse/plan'
import { handleVerify, VERIFY_SETTLE_MICRO_USD } from '../../functions/api/muse/verify'
import type { ProxyDeps } from '../../src/server/muse-proxy'

/**
 * C1 routing plus C2/C5 bookend routes: per-call stage model
 * selection, closed-schema verdicts, flat settles, hard timeouts
 * degrading instead of hanging, and diagnostics counters.
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

const planBody = {
  question: 'best schools near Hilo',
  intent: { mode: 'lookup', geographies: ['Hilo, HI'], measures: [] },
  criteria: [{ kind: 'research', text: 'good schools' }],
  subset: { count: 3, ranges: [] },
}

const verifyBody = {
  answerText: 'Hilo meets the schools criterion.',
  places: ['Hilo'],
  criteriaEvidence: [{ criterion: 'good schools', label: 'met' }],
  sources: [{ title: 'State report', url: 'https://example.org/x' }],
  verifySummary: 'figures strict-equal',
}

describe('C1 stage model selection', () => {
  it('the allowlist carries spark, the wonder candidate, and transcribe', () => {
    expect(PROXY_ALLOWED_MODELS).toEqual([
      'muse-spark-1.3',
      'muse-wonder-1.0',
      'muse-voice-transcribe-1.0',
    ])
    expect(MUSE_WONDER_MODEL).toBe('muse-wonder-1.0')
  })

  it('a request naming a non-allowlisted model is refused before any call', async () => {
    let called = false
    const d = deps({
      async stageChat() {
        called = true
        return { text: '{}', model: 'x' }
      },
    })
    const r = await handlePlan(
      { method: 'POST', path: '/api/muse/plan', body: { ...planBody, model: 'some-other-model' }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_allowlisted')
    expect(called).toBe(false)
  })

  it('the direct provider sends the named stage model and reports the reply model', async () => {
    let sentModel = ''
    const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
      sentModel = (JSON.parse(init.body ?? '{}') as { model?: string }).model ?? ''
      return new Response(
        JSON.stringify({
          model: 'muse-wonder-1.0',
          choices: [{ message: { content: '{"verdict":"sound","objections":[]}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const provider = createMetaDirectProvider({
      baseUrl: 'https://api.meta.ai/v1',
      model: 'muse-spark-1.3',
      getApiKey: () => 'test-key',
      fetchImpl,
    })
    const out = await provider.stageChat(
      { model: MUSE_WONDER_MODEL, system: 's', user: 'u' },
      new AbortController().signal,
    )
    expect(sentModel).toBe('muse-wonder-1.0')
    expect(out.model).toBe('muse-wonder-1.0')
    expect(out.text).toContain('sound')
  })
})

describe('top bookend route', () => {
  it('returns sound, settles 2000 flat, and counts the outcome', async () => {
    resetBookendCountersForTests()
    const d = deps({
      async stageChat(req) {
        expect(req.model).toBe(MUSE_WONDER_MODEL)
        expect(req.user).toContain('Screened subset: 3 places.')
        return { text: '{"verdict":"sound","objections":[]}', model: 'muse-wonder-1.0' }
      },
    })
    const r = await handlePlan({ method: 'POST', path: '/api/muse/plan', body: planBody, clientId: 'c1' }, d)
    expect(r.status).toBe(200)
    expect(r.body.outcome).toBe('sound')
    expect((d.meter as Meter).snapshot().spentMicroUsd).toBe(PLAN_SETTLE_MICRO_USD)
    expect(PLAN_SETTLE_MICRO_USD).toBe(2000)
    expect(bookendCountersSnapshot().top.sound).toBe(1)
  })

  it('returns unsound with its named objections', async () => {
    const d = deps({
      async stageChat() {
        return {
          text: '{"verdict":"unsound","objections":[{"code":"missing_criterion","detail":"fast food not decomposed"}]}',
          model: 'muse-wonder-1.0',
        }
      },
    })
    const r = await handlePlan({ method: 'POST', path: '/api/muse/plan', body: planBody, clientId: 'c1' }, d)
    expect(r.body.outcome).toBe('unsound')
    expect(r.body.objections).toEqual([
      { code: 'missing_criterion', detail: 'fast food not decomposed' },
    ])
  })

  it('a malformed verdict is a degradation, and a missing stage provider is too', async () => {
    resetBookendCountersForTests()
    const bad = deps({
      async stageChat() {
        return { text: 'the plan seems okay', model: 'muse-wonder-1.0' }
      },
    })
    const r1 = await handlePlan({ method: 'POST', path: '/api/muse/plan', body: planBody, clientId: 'c1' }, bad)
    expect(r1.body.outcome).toBe('degraded')
    const r2 = await handlePlan({ method: 'POST', path: '/api/muse/plan', body: planBody, clientId: 'c1' }, deps())
    expect(r2.body.outcome).toBe('degraded')
    expect(bookendCountersSnapshot().top.degraded).toBe(2)
  })

  it('rejects malformed plan shapes before any call', async () => {
    const d = deps({
      async stageChat() {
        throw new Error('must not be called')
      },
    })
    const r = await handlePlan(
      { method: 'POST', path: '/api/muse/plan', body: { question: 'x' }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('shape_invalid')
  })
})

describe('bottom bookend route', () => {
  it('labels verified only when a verdict ran, settles 2000 flat', async () => {
    resetBookendCountersForTests()
    const d = deps({
      async stageChat() {
        return { text: '{"verdict":"verified","concerns":[]}', model: 'muse-wonder-1.0' }
      },
    })
    const r = await handleVerify({ method: 'POST', path: '/api/muse/verify', body: verifyBody, clientId: 'c1' }, d)
    expect(r.status).toBe(200)
    expect(r.body.wonder).toBe('verified')
    expect((d.meter as Meter).snapshot().spentMicroUsd).toBe(VERIFY_SETTLE_MICRO_USD)
    expect(VERIFY_SETTLE_MICRO_USD).toBe(2000)
    expect(bookendCountersSnapshot().bottom.verified).toBe(1)
  })

  it('concerns carry through with their kind, and not_verified maps to concerns labeling', async () => {
    const d = deps({
      async stageChat() {
        return {
          text: '{"verdict":"not_verified","concerns":[{"kind":"factual","detail":"rent figure mismatch"}]}',
          model: 'muse-wonder-1.0',
        }
      },
    })
    const r = await handleVerify({ method: 'POST', path: '/api/muse/verify', body: verifyBody, clientId: 'c1' }, d)
    expect(r.body.wonder).toBe('concerns')
    expect(r.body.outcome).toBe('not_verified')
    expect(r.body.concerns).toEqual([{ kind: 'factual', detail: 'rent figure mismatch' }])
  })

  it('a provider failure labels not-run and claims nothing about Wonder', async () => {
    resetBookendCountersForTests()
    const d = deps({
      async stageChat(): Promise<never> {
        throw new Error('down')
      },
    })
    const r = await handleVerify({ method: 'POST', path: '/api/muse/verify', body: verifyBody, clientId: 'c1' }, d)
    expect(r.status).toBe(200)
    expect(r.body.wonder).toBe('not-run')
    expect(r.body.outcome).toBe('degraded')
    expect(bookendCountersSnapshot().bottom.notRun).toBe(1)
  })
})

describe('stage timeout', () => {
  it('a call that never settles is cut by the timeout, not awaited', async () => {
    const started = Date.now()
    await expect(
      withStageTimeout(30, () => new Promise<never>(() => {})),
    ).rejects.toThrow('stage_timeout')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a call inside the timeout returns its value', async () => {
    await expect(withStageTimeout(1000, async () => 'ok')).resolves.toBe('ok')
  })
})
