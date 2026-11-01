import { describe, expect, it } from 'vitest'
import {
  ProviderCallError,
  createLiveProvider,
  mapMetaFailure,
  META_API_BASE,
  MUSE_SPARK_MODEL,
} from '../../src/core/ai/meta-client'
import type { ExplainRequest, IntentRequest } from '../../src/core/ai/provider'

/**
 * These tests are hermetic: a fake fetch stands at the network boundary, so
 * nothing here needs a key, credits, or a reachable Meta origin. The live tier
 * is a separate, credit-budgeted run; a green result here says the wiring and
 * the error mapping are right, not that the model answered well.
 */

interface Call {
  url: string
  init: RequestInit
  body: unknown
}

function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  let index = 0
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(call)
    const reply = replies[Math.min(index, replies.length - 1)]!
    index += 1
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const INTENT_REQUEST: IntentRequest = {
  slots: { geographyHints: [], metricHints: [] },
  queryText: 'rent in 96778',
  locale: 'en',
}

const INTENT = {
  mode: 'lookup',
  geographies: ['96778'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

const EXPLAIN_REQUEST: ExplainRequest = {
  figureSetId: 'lookup',
  values: [{ key: 'median_gross_rent', value: 1500, marginOfError: 120 }],
}

const KEY = 'k'.repeat(40)

function provider(fetchImpl: typeof fetch, withByo = true) {
  return createLiveProvider({
    fetchImpl,
    direct: withByo
      ? { baseUrl: META_API_BASE, model: MUSE_SPARK_MODEL, getApiKey: () => KEY }
      : undefined,
  })
}

describe('live provider: proxy path', () => {
  it('sends the intent to the same-origin proxy and returns the parsed intent', async () => {
    const { impl, calls } = fakeFetch([{ body: { intent: INTENT } }])
    const result = await provider(impl, false).intent(INTENT_REQUEST, new AbortController().signal)
    expect(result.intent).toEqual(INTENT)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/muse/intent')
    expect((calls[0]!.body as { queryText: string }).queryText).toBe('rent in 96778')
    // The shared key lives server-side; the browser must never carry it.
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('carries a withheld explain verdict as a state, not as empty prose', async () => {
    const { impl } = fakeFetch([{ body: { withheld: true, failure: 'invented_numeral' } }])
    const result = await provider(impl, false).explain(EXPLAIN_REQUEST, new AbortController().signal)
    expect(result.withheld).toBe(true)
    expect(result.prose).toBe('')
    // The class travels as a closed enum so diagnostics can count it.
    expect(result.withholdClass).toBe('invented_numeral')
  })

  it('refuses an over-long query before spending a request', async () => {
    const { impl, calls } = fakeFetch([{ body: { intent: INTENT } }])
    await expect(
      provider(impl, false).intent(
        { ...INTENT_REQUEST, queryText: 'x'.repeat(501) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'shape_invalid' })
    expect(calls).toHaveLength(0)
  })

  it('reports a closed error code when the proxy is shut off and no BYO key exists', async () => {
    const { impl, calls } = fakeFetch([{ status: 429, body: { error: 'budget_exhausted' } }])
    await expect(
      provider(impl, false).intent(INTENT_REQUEST, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(calls).toHaveLength(1)
  })
})

describe('live provider: BYO fallback', () => {
  it('retries direct after a shared shutdown, with structured output and the visitor key', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: { error: 'budget_exhausted' } },
      {
        body: {
          choices: [{ message: { role: 'assistant', content: JSON.stringify(INTENT) } }],
        },
      },
    ])
    const result = await provider(impl).intent(INTENT_REQUEST, new AbortController().signal)
    expect(result.intent).toEqual(INTENT)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe(`${META_API_BASE}/chat/completions`)
    const second = calls[1]!
    const headers = second.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    const body = second.body as {
      model: string
      response_format: { type: string; json_schema: { schema: { properties: { metricKeys: { items: { enum: string[] } } } } } }
    }
    expect(body.model).toBe(MUSE_SPARK_MODEL)
    expect(body.response_format.type).toBe('json_schema')
    // Registry = surface: the schema's allowlist is the product registry, not a
    // hand-maintained copy that could drift from it.
    expect(body.response_format.json_schema.schema.properties.metricKeys.items.enum).toContain(
      'median_gross_rent',
    )
  })

  it('does not fall back for an error that is not a shutdown', async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: { error: 'shape_invalid' } }])
    await expect(
      provider(impl).intent(INTENT_REQUEST, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'shape_invalid' })
    expect(calls).toHaveLength(1)
  })

  it('maps provider statuses onto the product taxonomy', () => {
    expect(mapMetaFailure(401, { error: { code: 'invalid_api_key' } })).toBe('bad_key')
    expect(mapMetaFailure(429, { error: { code: 'rate_limit_exceeded' } })).toBe('rate_limited')
    expect(mapMetaFailure(402, { error: { code: 'billing_not_configured' } })).toBe('credits_exhausted')
    expect(mapMetaFailure(500, null)).toBe('provider_down')
  })

  it('reports a malformed structured reply as a shape failure, never as an intent', async () => {
    const { impl } = fakeFetch([
      { status: 429, body: { error: 'budget_exhausted' } },
      { body: { choices: [{ message: { content: 'not json' } }] } },
    ])
    await expect(
      provider(impl).intent(INTENT_REQUEST, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'shape_invalid' })
  })
})

describe('live provider: cut features refuse rather than invent', () => {
  it('refuses transcribe (voice stays cut, issue #61)', async () => {
    const { impl, calls } = fakeFetch([{ body: {} }])
    const live = provider(impl, false)
    await expect(
      live.transcribe({ audio: new ArrayBuffer(0), mimeType: 'audio/webm' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_down' })
    expect(calls).toHaveLength(0)
  })

  it('briefing is no longer cut (F6, issue #58): it goes through the proxy route', async () => {
    const { impl, calls } = fakeFetch([{ body: { prose: 'Households number 3400 here.' } }])
    const live = provider(impl, false)
    const result = await live.briefing(
      { figureSetId: 'x', values: [{ key: 'households', value: 3400 }] },
      new AbortController().signal,
    )
    expect(result.prose).toContain('3400')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/muse/briefing')
  })
})
