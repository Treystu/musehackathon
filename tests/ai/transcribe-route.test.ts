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

  it('audio metering: the call settles into the meter as counts only', async () => {
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

  it('rejects audio over the ceiling before any provider call or reservation', async () => {
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

  it('maps provider failures onto the closed taxonomy and releases the reservation', async () => {
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
    // Reservation was released: the same client can immediately succeed.
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

  it('hard shutoff: an exhausted budget returns budget_exhausted before the provider', async () => {
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
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('budget_exhausted')
    expect(calls).toBe(0)
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
