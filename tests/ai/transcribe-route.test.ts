import { describe, expect, it } from 'vitest'
import {
  Meter,
  defaultMeterConfig,
  type MeterConfig,
} from '../../src/core/ai/meter'
import {
  createStubProvider,
  type MuseProvider,
  type TranscribeRequest,
} from '../../src/core/ai/provider'
import {
  handleTranscribe,
  MAX_AUDIO_BYTES,
} from '../../functions/api/muse/transcribe'

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function deps(provider: MuseProvider = createStubProvider(), cfg?: MeterConfig) {
  return {
    meter: new Meter(cfg ?? defaultMeterConfig()),
    provider,
    allowedModels: ['spark-test'],
    // Taxonomy tests: production wait-out timing would stall them.
    waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
  }
}

function req(body: unknown, path = '/api/muse/transcribe') {
  return { method: 'POST', path, body, clientId: 'c1' }
}

const AUDIO = { mimeType: 'audio/webm', audioBase64: b64(new Uint8Array(2048)) }

describe('transcribe route (Item 12)', () => {
  it('happy path: calls the provider with the decoded audio and returns the transcript', async () => {
    let seen: TranscribeRequest | null = null
    const provider = createStubProvider({
      async transcribe(r) {
        seen = r
        return { transcript: 'rent in Hilo', confidence: 0.93 }
      },
    })
    const d = deps(provider)
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ transcript: 'rent in Hilo', confidence: 0.93 })
    expect(seen).not.toBeNull()
    expect(seen!.audio.byteLength).toBe(2048)
    expect(seen!.mimeType).toBe('audio/webm')
  })

  it('audio metering: the call records into the meter as counts only', async () => {
    const d = deps(
      createStubProvider({
        async transcribe() {
          return { transcript: 'rent in Hilo under two thousand', confidence: 0.9 }
        },
      }),
    )
    const before = d.meter.snapshot()
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(200)
    const after = d.meter.snapshot()
    expect(after.requests).toBe(before.requests + 1)
    expect(after.spentMicroUsd).toBeGreaterThan(before.spentMicroUsd)
    expect(after.tokensIn).toBeGreaterThan(before.tokensIn)
    expect(after.tokensOut).toBeGreaterThan(before.tokensOut)
    // Counts only (Q1): no transcript text anywhere in the snapshot.
    expect(JSON.stringify(after)).not.toContain('rent in Hilo')
  })

  it('accepts a codec parameter on the mime type and passes the bare type on', async () => {
    let seenType = ''
    const d = deps(
      createStubProvider({
        async transcribe(r) {
          seenType = r.mimeType
          return { transcript: 'x', confidence: 1 }
        },
      }),
    )
    const r = await handleTranscribe(
      req({ mimeType: 'audio/webm;codecs=opus', audioBase64: AUDIO.audioBase64 }),
      d,
    )
    expect(r.status).toBe(200)
    expect(seenType).toBe('audio/webm')
  })

  it('shape checks: missing fields, unsupported type, malformed base64, empty audio', async () => {
    const d = deps()
    const missing = await handleTranscribe(req({ mimeType: 'audio/webm' }), d)
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('shape_invalid')

    const noMime = await handleTranscribe(req({ audioBase64: AUDIO.audioBase64 }), d)
    expect(noMime.body.error).toBe('shape_invalid')

    const badType = await handleTranscribe(
      req({ mimeType: 'video/mp4', audioBase64: AUDIO.audioBase64 }),
      d,
    )
    expect(badType.body.error).toBe('shape_invalid')

    const badB64 = await handleTranscribe(
      req({ mimeType: 'audio/webm', audioBase64: 'not!base64!' }),
      d,
    )
    expect(badB64.body.error).toBe('shape_invalid')

    const empty = await handleTranscribe(
      req({ mimeType: 'audio/webm', audioBase64: '' }),
      d,
    )
    expect(empty.body.error).toBe('shape_invalid')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('rejects audio over the ceiling before any provider call', async () => {
    let calls = 0
    const d = deps(
      createStubProvider({
        async transcribe() {
          calls++
          return { transcript: 'x', confidence: 1 }
        },
      }),
    )
    // Base64 length chosen so the decoded size is just over the ceiling;
    // the route rejects from the length alone, without decoding.
    const overLength = Math.ceil((MAX_AUDIO_BYTES + 3) / 3) * 4
    const r = await handleTranscribe(
      req({ mimeType: 'audio/webm', audioBase64: 'A'.repeat(overLength) }),
      d,
    )
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('shape_invalid')
    expect(calls).toBe(0)
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('allowlist: non-allowlisted path and model are rejected', async () => {
    const d = deps()
    const wrongPath = await handleTranscribe(req(AUDIO, '/api/muse/intent'), d)
    expect(wrongPath.body.error).toBe('not_allowlisted')
    const wrongModel = await handleTranscribe(req({ ...AUDIO, model: 'other-model' }), d)
    expect(wrongModel.body.error).toBe('not_allowlisted')
    const get = await handleTranscribe({ method: 'GET', path: '/api/muse/transcribe', body: AUDIO, clientId: 'c1' }, d)
    expect(get.body.error).toBe('not_allowlisted')
  })

  it('maps provider failures onto the closed taxonomy and counts nothing', async () => {
    let fail = true
    const d = deps(
      createStubProvider({
        async transcribe() {
          if (fail) throw Object.assign(new Error('rl'), { code: 'rate_limited' })
          return { transcript: 'ok', confidence: 0.9 }
        },
      }),
    )
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate_limited')
    expect(d.meter.snapshot().requests).toBe(0)
    expect(d.meter.snapshot().errors.rate_limited).toBe(1)
    // No admission state lingers from the failure: the same client
    // can immediately succeed (one failure is below the breaker
    // threshold, and nothing was reserved against any cap).
    fail = false
    const ok = await handleTranscribe(req(AUDIO), d)
    expect(ok.status).toBe(200)
  })

  it('maps a bad key onto the taxonomy', async () => {
    const d = deps(
      createStubProvider({
        async transcribe() {
          throw Object.assign(new Error('k'), { code: 'bad_key' })
        },
      }),
    )
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('bad_key')
  })

  it('unusable provider output is provider_down, never forwarded', async () => {
    const badOutputs: unknown[] = [
      { transcript: 42, confidence: 0.9 },
      { transcript: 'x', confidence: 1.5 },
      { transcript: 'x', confidence: Number.NaN },
      { transcript: 'x'.repeat(2001), confidence: 0.9 },
    ]
    for (const out of badOutputs) {
      const d = deps(
        createStubProvider({
          async transcribe() {
            return out as { transcript: string; confidence: number }
          },
        }),
      )
      const r = await handleTranscribe(req(AUDIO), d)
      expect(r.status).toBe(502)
      expect(r.body.error).toBe('provider_down')
      expect(d.meter.snapshot().requests).toBe(0)
    }
  })

  it('no hard shutoff: an over-cap meter still serves and keeps counting', async () => {
    // Accounting-only contract (2026-11-02): the budget cap is a
    // reporting threshold. Spend past it is reported by the snapshot,
    // never refused at the route.
    let calls = 0
    const d = deps(
      createStubProvider({
        async transcribe() {
          calls++
          return { transcript: 'x', confidence: 1 }
        },
      }),
      { ...defaultMeterConfig(), budgetCapMicroUsd: 1 },
    )
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(200)
    expect(r.body.transcript).toBe('x')
    expect(calls).toBe(1)
    expect(d.meter.snapshot().budgetExhausted).toBe(true)
    expect(d.meter.snapshot().requests).toBe(1)
  })

  it('wait-out parity: a provider that recovers inside the retry schedule answers 200', async () => {
    // Transcribe shares the sibling routes' provider-health path
    // (preCallGate wait-out + attemptCall retries); this and the
    // next test pin that parity, which the plan's Phase 5 calls out.
    let calls = 0
    const d = deps(
      createStubProvider({
        async transcribe() {
          calls += 1
          if (calls < 3) throw Object.assign(new Error('down'), { code: 'provider_down' })
          return { transcript: 'rent in Hilo', confidence: 0.9 }
        },
      }),
    )
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(200)
    expect(calls).toBe(3)
    expect(d.meter.snapshot().requests).toBe(1)
  })

  it('wait-out parity: an open breaker that lifts inside the wait budget is served', async () => {
    const meter = new Meter({
      ...defaultMeterConfig(),
      breakerFailureThreshold: 1,
      breakerCooldownMs: 30,
    })
    meter.recordFailure()
    expect(meter.breakerState()).toBe('open')
    const d = {
      meter,
      provider: createStubProvider({
        async transcribe() {
          return { transcript: 'ok', confidence: 0.9 }
        },
      }),
      allowedModels: ['spark-test'],
      waitOut: { breakerWaitMs: 5_000, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
    }
    const r = await handleTranscribe(req(AUDIO), d)
    expect(r.status).toBe(200)
    expect(r.body.transcript).toBe('ok')
  })

  it('breaker: repeated provider failures open the breaker for later calls', async () => {
    const d = deps(
      createStubProvider({
        async transcribe() {
          throw new Error('down')
        },
      }),
      { ...defaultMeterConfig(), breakerFailureThreshold: 1 },
    )
    const first = await handleTranscribe(req(AUDIO), d)
    expect(first.status).toBe(502)
    const second = await handleTranscribe(req(AUDIO), d)
    expect(second.status).toBe(503)
    expect(second.body.error).toBe('breaker_open')
  })
})
