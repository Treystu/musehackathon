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

function provider(fetchImpl: typeof fetch, withByo = true, storedKey: string | null = KEY) {
  return createLiveProvider({
    fetchImpl,
    direct: withByo
      ? { baseUrl: META_API_BASE, model: MUSE_SPARK_MODEL, getApiKey: () => storedKey }
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

  it('does not convert a proxy shutdown into bad_key when BYO is configured but no key is stored', async () => {
    const { impl, calls } = fakeFetch([{ status: 503, body: { error: 'breaker_open' } }])
    await expect(
      provider(impl, true, null).intent(INTENT_REQUEST, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'breaker_open' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/muse/intent')
  })

  it('surfaces the proxy error for briefing too when no BYO key is stored', async () => {
    const { impl, calls } = fakeFetch([{ status: 429, body: { error: 'credits_exhausted' } }])
    await expect(
      provider(impl, true, null).briefing(
        { figureSetId: 'x', values: [{ key: 'households', value: 3400 }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'credits_exhausted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/muse/briefing')
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

describe('research via the Responses API (grounding is Responses-only)', () => {
  const RESPONSES_REPLY = {
    output: [
      { type: 'web_search_call', results: [{ title: 'Search hit', url: 'https://example.org/hit' }] },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'The area schools are well rated.',
            annotations: [
              { type: 'url_citation', url: 'https://example.org/doe', title: 'State DOE' },
            ],
          },
        ],
      },
    ],
  }

  it('direct provider posts a web_search tool call and parses prose + citations', async () => {
    const { impl, calls } = fakeFetch([{ body: RESPONSES_REPLY }])
    const live = provider(impl, true)
    // Force the BYO path: proxy reports the shared budget exhausted.
    const proxied = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/muse/research') {
        return new Response(JSON.stringify({ error: 'budget_exhausted' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      return impl(input, init)
    }) as unknown as typeof fetch
    const byo = provider(proxied, true)
    const result = await byo.research(
      { queryText: 'best schools near Hilo', places: ['Hilo'] },
      new AbortController().signal,
    )
    expect(result.prose).toContain('well rated')
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://example.org/hit',
      'https://example.org/doe',
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/responses')
    const body = calls[0]!.body as { tools?: Array<{ type: string }> }
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }])
    void live
  })

  it('a reply with no citations is refused as ungrounded', async () => {
    const { impl } = fakeFetch([
      { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Trust me.', annotations: [] }] }] } },
    ])
    const direct = provider(impl, true)
    // The proxy path 200s a sourced reply shape of its own in other
    // tests; here the first call IS the proxy (fakeFetch serves the
    // same body), whose prose has no sources -> parse refuses.
    await expect(
      direct.research({ queryText: 'schools?' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_down' })
  })

  it('live provider returns the route reply through the proxy', async () => {
    const { impl, calls } = fakeFetch([
      { body: { prose: 'Findings.', sources: [{ title: 'T', url: 'https://example.org' }] } },
    ])
    const live = provider(impl, false)
    const result = await live.research(
      { queryText: 'starbucks near Hilo?' },
      new AbortController().signal,
    )
    expect(result).toEqual({
      prose: 'Findings.',
      sources: [{ title: 'T', url: 'https://example.org' }],
    })
    expect(calls[0]!.url).toBe('/api/muse/research')
  })
})

describe('live provider: transcribe (voice un-cut by owner directive, 2026-11-01)', () => {
  const AUDIO = new Uint8Array([1, 2, 3, 4]).buffer

  it('sends the audio to the proxy route and returns the parsed transcript', async () => {
    const { impl, calls } = fakeFetch([
      { body: { transcript: 'rent in Hilo', confidence: 0.93 } },
    ])
    const live = provider(impl, false)
    const result = await live.transcribe(
      { audio: AUDIO, mimeType: 'audio/webm' },
      new AbortController().signal,
    )
    expect(result).toEqual({ transcript: 'rent in Hilo', confidence: 0.93 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/muse/transcribe')
    const body = calls[0]!.body as { mimeType: string; audioBase64: string }
    expect(body.mimeType).toBe('audio/webm')
    expect(body.audioBase64).toBe(Buffer.from(new Uint8Array(AUDIO)).toString('base64'))
  })

  it('rejects an unusable proxy reply instead of inventing a transcript', async () => {
    const { impl } = fakeFetch([{ body: { transcript: 'rent in Hilo' } }])
    const live = provider(impl, false)
    await expect(
      live.transcribe({ audio: AUDIO, mimeType: 'audio/webm' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_down' })
  })

  it('BYO fallback: the direct provider posts WAV multipart to the ASR endpoint', async () => {
    // Muse Spark takes no audio input; transcription is the dedicated
    // Muse Voice Transcribe endpoint (POST /v1/asr/transcribe), whose
    // multipart carries a JSON `request` part and the WAV `audio` part,
    // and whose reply is { transcript } with no confidence score.
    const seen: Array<{ url: string; form: FormData | null }> = []
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/muse/transcribe') {
        return new Response(JSON.stringify({ error: 'budget_exhausted' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      seen.push({ url, form: (init?.body as FormData) ?? null })
      return new Response(JSON.stringify({ transcript: 'rent in Hilo', turns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const live = provider(impl, true)
    const result = await live.transcribe(
      { audio: AUDIO, mimeType: 'audio/wav' },
      new AbortController().signal,
    )
    // No confidence exists upstream: a returned transcript counts as 1.
    expect(result).toEqual({ transcript: 'rent in Hilo', confidence: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://api.meta.ai/v1/asr/transcribe')
    const form = seen[0]!.form
    expect(form).toBeInstanceOf(FormData)
    const requestPart = JSON.parse(await (form!.get('request') as Blob).text()) as {
      model?: string
      audioEncoding?: string
    }
    expect(requestPart.model).toBe('muse-voice-transcribe-1.0')
    expect(requestPart.audioEncoding).toBe('WAV')
    expect(form!.get('audio')).toBeTruthy()
  })

  it('direct transcribe refuses a non-WAV recording before any fetch', async () => {
    // The proxy reports the shared budget exhausted (a BYO-fallback
    // class), so the direct provider is reached — and must refuse the
    // webm shape itself, without an ASR fetch: the endpoint takes WAV.
    const { impl, calls } = fakeFetch([
      { status: 429, body: { error: 'budget_exhausted' } },
    ])
    const live = provider(impl, true)
    await expect(
      live.transcribe({ audio: AUDIO, mimeType: 'audio/webm' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'shape_invalid' })
    expect(calls).toHaveLength(1) // proxy attempt only; no ASR fetch
  })

  it('an empty ASR transcript comes back with confidence 0', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input) === '/api/muse/transcribe') {
        return new Response(JSON.stringify({ error: 'budget_exhausted' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ transcript: '', turns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const live = provider(impl, true)
    await expect(
      live.transcribe({ audio: AUDIO, mimeType: 'audio/wav' }, new AbortController().signal),
    ).resolves.toEqual({ transcript: '', confidence: 0 })
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
