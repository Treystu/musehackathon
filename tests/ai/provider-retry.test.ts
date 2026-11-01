/**
 * The bounded retry in the Meta provider's completion path.
 *
 * Measured live (2026-11-01, against the deployed portal): the same key and
 * the same request alternated between clean parses and 401-class rejections
 * in minute-scale windows, depending on the client network. One retry turns
 * a per-attempt failure into a per-pair failure; these tests pin the bound —
 * exactly one retry, only on the flapping classes — so the mitigation can
 * never grow into a loop or mask a genuinely bad key.
 */
import { describe, expect, it } from 'vitest'
import { createMetaDirectProvider, ProviderCallError } from '../../src/core/ai/meta-client'

const INTENT_JSON = JSON.stringify({
  mode: 'lookup',
  geographies: ['Austin, TX'],
  metricKeys: ['median_home_value'],
  filters: [],
  clarificationNeeded: false,
})

function okReply(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: INTENT_JSON } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorReply(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function providerWith(fetchImpl: (call: number) => Promise<Response>) {
  let calls = 0
  const provider = createMetaDirectProvider({
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    getApiKey: () => 'test-key',
    fetchImpl: async () => fetchImpl(++calls),
  })
  return { provider, calls: () => calls }
}

const REQ = {
  slots: { geographyHints: [], metricHints: [] },
  queryText: 'What is the median home value in Austin, Texas?',
  locale: 'en' as const,
}

describe('provider completion retry', () => {
  it('resolves when the first attempt is rejected as a bad key and the second succeeds', async () => {
    const { provider, calls } = providerWith(async (n) =>
      n === 1 ? errorReply(401, 'invalid_api_key') : okReply(),
    )
    const result = await provider.intent(REQ, new AbortController().signal)
    expect(result.intent.mode).toBe('lookup')
    expect(calls()).toBe(2)
  })

  it('surfaces bad_key after exactly two rejected attempts', async () => {
    const { provider, calls } = providerWith(async () => errorReply(401, 'invalid_api_key'))
    await expect(provider.intent(REQ, new AbortController().signal)).rejects.toMatchObject({
      code: 'bad_key',
    })
    expect(calls()).toBe(2)
  })

  it('retries a network failure once', async () => {
    const { provider, calls } = providerWith(async (n) => {
      if (n === 1) throw new TypeError('fetch failed')
      return okReply()
    })
    const result = await provider.intent(REQ, new AbortController().signal)
    expect(result.intent.mode).toBe('lookup')
    expect(calls()).toBe(2)
  })

  it('never retries a rate limit', async () => {
    const { provider, calls } = providerWith(async () => errorReply(429, 'rate_limit_exceeded'))
    const err = await provider.intent(REQ, new AbortController().signal).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderCallError)
    expect((err as ProviderCallError).code).toBe('rate_limited')
    expect(calls()).toBe(1)
  })
})
