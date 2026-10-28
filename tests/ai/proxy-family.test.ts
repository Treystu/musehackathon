import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider } from '../../src/core/ai/provider'
import { handleExplain } from '../../functions/api/muse/explain'
import { handleTranscribe } from '../../functions/api/muse/transcribe'
import { handleIntent } from '../../functions/api/muse/intent'
import { decideAskPath, shouldOfferByo } from '../../src/core/ai/byo'

function deps() {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(),
    allowedModels: ['spark-test'],
  }
}

describe('proxy route family shells', () => {
  it('explain validates shape and returns validated stub prose', async () => {
    const d = deps()
    const bad = await handleExplain({ method: 'POST', path: '/api/muse/explain', body: {}, clientId: 'c1' }, d)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('shape_invalid')
    const ok = await handleExplain(
      { method: 'POST', path: '/api/muse/explain', body: { figureSetId: 'f1', values: [] }, clientId: 'c1' }, d)
    expect(ok.status).toBe(200)
    expect(ok.body.prose).toBe('')
  })

  it('transcribe shell is allowlisted + metered, rejects oversize audio', async () => {
    const d = deps()
    const big = await handleTranscribe(
      { method: 'POST', path: '/api/muse/transcribe', body: { mimeType: 'audio/webm', audioBytes: 99_000_000 }, clientId: 'c1' }, d)
    expect(big.body.error).toBe('shape_invalid')
    const ok = await handleTranscribe(
      { method: 'POST', path: '/api/muse/transcribe', body: { mimeType: 'audio/webm', audioBytes: 1024 }, clientId: 'c1' }, d)
    expect(ok.status).toBe(503)
    expect(d.meter.snapshot().errors.provider_down).toBeGreaterThan(0)
  })

  it('all shells reject non-allowlisted paths/models', async () => {
    const d = deps()
    const r = await handleExplain(
      { method: 'POST', path: '/api/muse/intent', body: { figureSetId: 'x', values: [] }, clientId: 'c1' }, d)
    expect(r.body.error).toBe('not_allowlisted')
    const m = await handleIntent(
      { method: 'POST', path: '/api/muse/intent', body: { slots: {}, model: 'other-model' }, clientId: 'c1' }, d)
    expect(m.body.error).toBe('not_allowlisted')
  })

  it('intent maps provider rate-limit onto closed taxonomy', async () => {
    const d = {
      meter: new Meter(defaultMeterConfig()),
      provider: createStubProvider({
        async intent() { throw Object.assign(new Error('rl'), { code: 'rate_limited' }) },
      }),
      allowedModels: ['spark-test'],
    }
    const r = await handleIntent({ method: 'POST', path: '/api/muse/intent', body: { slots: {} }, clientId: 'c1' }, d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate_limited')
  })

  it('meter counts errors by class, counts only', () => {
    const m = new Meter(defaultMeterConfig())
    m.recordError('provider_down'); m.recordError('provider_down'); m.recordError('shape_invalid')
    expect(m.snapshot().errors).toEqual({ provider_down: 2, shape_invalid: 1 })
  })
})

describe('BYO placement rules', () => {
  it('shared on happy path; BYO only beyond allowance; never required', () => {
    expect(decideAskPath({ budgetExhausted: false, breakerOpen: false, hasByoKey: false })).toBe('shared')
    expect(decideAskPath({ budgetExhausted: true, breakerOpen: false, hasByoKey: true })).toBe('byo')
    expect(decideAskPath({ budgetExhausted: true, breakerOpen: false, hasByoKey: false })).toBe('unavailable')
    expect(shouldOfferByo('budget_exhausted')).toBe(true)
    expect(shouldOfferByo('provider_down')).toBe(false)
  })
})
