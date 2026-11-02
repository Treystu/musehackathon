/**
 * Live Muse provider: the client behind Ask and Explain.
 *
 * Mirror of the plan's hybrid key architecture (D1/D2, plan section 5): the
 * same-origin proxy at /api/muse/* spends the shared allowance first, and a
 * visitor's own Meta key is used only after the shared path is shut off. The
 * proxy is stateless and metered; the BYO key never leaves the browser except
 * as an Authorization header to the Meta origin (meta-key.ts holds it).
 *
 * Two details are load-bearing and were measured against the Meta Model API
 * documentation rather than guessed:
 *   - POST https://api.meta.ai/v1/chat/completions, OpenAI-shaped body, and
 *     generated text at choices[0].message.content.
 *   - Errors arrive as {error:{code}}. A 402 is a billing problem
 *     (`billing_*`), which is what an exhausted allowance looks like here; the
 *     plan's `credits_exhausted` class is a product label, not a provider code.
 *     A 200 with an HTML body is impossible here, so unlike the Census client
 *     the status code can be trusted -- but the body is still parsed before it
 *     is used, because a status alone has lied to this codebase before.
 */
import { DISPLAYABLE_KEYS, FILTER_LEGAL_KEYS, isKnownFigureKey } from './intent-schema'
import type {
  BriefingRequest,
  BriefingResult,
  ExplainRequest,
  ExplainResult,
  IntentRequest,
  IntentResult,
  MuseProvider,
  TranscribeRequest,
  TranscribeResult,
} from './provider'
import { PROXY_ERRORS, type ProxyError } from './proxy-errors'
import { VALIDATOR_FAILURES, type ValidatorFailure } from './validator'

/** Meta Model API origin and shape (dev.meta.ai docs, verified 2026-10-29). */
export const META_API_BASE = 'https://api.meta.ai/v1'

/**
 * The runtime model. Muse Spark is the tier the plan assigns to runtime work;
 * Muse Wonder is offline-only and never reachable from this client.
 */
export const MUSE_SPARK_MODEL = 'muse-spark-1.3'

/** Ceiling mirrored from the proxy's intent parser, so the two cannot drift. */
export const MAX_INTENT_QUERY_CHARS = 500

/** Errors after which the BYO path is the honest next attempt. */
const BYO_FALLBACK_ERRORS: ReadonlySet<ProxyError> = new Set([
  'budget_exhausted',
  'credits_exhausted',
  'breaker_open',
])

/** A closed-taxonomy failure, shaped so AskPanel's extractProxyError reads it. */
export class ProviderCallError extends Error {
  readonly code: ProxyError
  constructor(code: ProxyError) {
    super(code)
    this.name = 'ProviderCallError'
    this.code = code
  }
}

function isProxyError(value: unknown): value is ProxyError {
  return typeof value === 'string' && (PROXY_ERRORS as readonly string[]).includes(value)
}

/** Map a Meta error body/status onto the product's closed taxonomy. */
export function mapMetaFailure(status: number, body: unknown): ProxyError {
  const code =
    typeof body === 'object' && body !== null
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined
  if (code === 'invalid_api_key' || status === 401) return 'bad_key'
  if (code === 'rate_limit_exceeded' || status === 429) return 'rate_limited'
  if (typeof code === 'string' && code.startsWith('billing_')) return 'credits_exhausted'
  if (status === 402) return 'credits_exhausted'
  return 'provider_down'
}

type FetchLike = typeof fetch

export interface DirectConfig {
  baseUrl: string
  model: string
  /** Read lazily: the key can be stored after the provider is constructed. */
  getApiKey: () => string | null
}

export interface LiveProviderOptions {
  /** Same-origin proxy prefix. '' means the page's own origin. */
  proxyBase?: string
  /** BYO-direct configuration. Absent means no visitor-key path. */
  direct?: DirectConfig
  /** Injected for hermetic tests; never a network in the default path of a test. */
  fetchImpl?: FetchLike
}

export interface MetaDirectOptions extends DirectConfig {
  fetchImpl?: FetchLike
}

/** Registry-derived intent schema for structured output. */
export function intentJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'geographies', 'metricKeys', 'filters', 'clarificationNeeded'],
    properties: {
      mode: { type: 'string', enum: ['lookup', 'compare', 'sweep_filter', 'similarity'] },
      geographies: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string', minLength: 1 },
      },
      metricKeys: {
        type: 'array',
        items: { type: 'string', enum: [...DISPLAYABLE_KEYS] },
      },
      filters: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['metricKey', 'op', 'value'],
          properties: {
            metricKey: { type: 'string', enum: [...FILTER_LEGAL_KEYS] },
            op: { type: 'string', enum: ['gt', 'lt', 'eq_range'] },
            value: { type: 'number' },
          },
        },
      },
      clarificationNeeded: { type: 'boolean' },
    },
  }
}

const INTENT_SYSTEM_PROMPT = [
  'You turn a question about United States housing and neighbourhood data into one JSON object.',
  'Use only the metric keys the response schema allows. Never invent a metric key.',
  'Geographies must be 5-digit US ZIP codes when the question names one, otherwise "City, ST".',
  'For a sweep over a whole state, return the state two-letter code (for example "HI") as the only geography.',
  'Modes: lookup (one place), compare (two or more places), sweep_filter (a bound over many places),',
  'similarity (places similar to one place). Wording like "similar to", "like", or "comparable to"',
  'a named place is similarity mode with that place as the only geography — never an empty lookup.',
  'Never rank, recommend, or characterise people or places. If the question asks for a ranking or a',
  'recommendation, clarify rather than complying: return clarificationNeeded true, keep every place',
  'or state the question names in geographies, and clarify only for the measure or detail that is',
  'actually missing.',
  'Some criteria are not in this data at all: political leaning, voter registration, party',
  'affiliation, crime, and school quality have no metric keys. Never invent a key for them, and',
  'never let an unservable criterion discard a place, state, or measure the question does name.',
  'If a place or measure is missing or ambiguous, set clarificationNeeded true rather than guessing.',
  'If a place is missing, ambiguous, or cannot be resolved, return mode "lookup" with no geographies',
  'and no metric keys and clarificationNeeded true.',
  'Express percentage bounds with one decimal place (for example 33.3).',
  'Return only the JSON object.',
].join(' ')

const EXPLAIN_SYSTEM_PROMPT = [
  'You explain figures that were already retrieved by a deterministic data tool.',
  'Write two or three plain sentences about what the supplied figures show.',
  'Use only numbers that appear in the supplied figures. Do not compute or introduce any number.',
  'Do not rank places, recommend a place, or describe people. Do not call any place good, bad, safe,',
  'or desirable. If a margin of error is wide relative to the figure, say the estimate is uncertain.',
  'Never claim a difference is real when the margins of error overlap. Plain prose only.',
].join(' ')

const BRIEFING_SYSTEM_PROMPT = [
  'You write the narrative for a briefing pack whose figures were already retrieved by a',
  'deterministic data tool and re-verified against their sources before you were called.',
  'Write a short plain paragraph about what the supplied figures show, for a reader who',
  'will use the pack to brief other people. Use only numbers that appear in the supplied',
  'figures. Do not compute or introduce any number. Do not rank places, recommend a place,',
  'or describe people. Do not call any place good, bad, safe, or desirable. If a margin of',
  'error is wide relative to the figure, say the estimate is uncertain. Never claim a',
  'difference is real when the margins of error overlap. Plain prose only.',
].join(' ')

function briefingUserPrompt(req: BriefingRequest): string {
  const rows = req.values.map((v) => {
    const moe =
      typeof v.marginOfError === 'number'
        ? ` plus or minus ${v.marginOfError}`
        : ' (no margin published)'
    const value = v.value === null ? 'no reportable value' : String(v.value)
    return `- ${v.key}: ${value}${moe}`
  })
  return [`Briefing pack: ${req.figureSetId}`, 'Verified figures:', ...rows].join('\n')
}

function intentUserPrompt(req: IntentRequest): string {
  const parts: string[] = []
  if (req.queryText) parts.push(`Question: ${req.queryText}`)
  if (req.slots.geographyHints.length > 0) {
    parts.push(`Places already recognised by the app: ${req.slots.geographyHints.join(', ')}`)
  }
  if (req.slots.metricHints.length > 0) {
    parts.push(`Measures already recognised by the app: ${req.slots.metricHints.join(', ')}`)
  }
  if (req.slots.modeHint) parts.push(`Mode the app believes applies: ${req.slots.modeHint}`)
  return parts.join('\n')
}

function explainUserPrompt(req: ExplainRequest): string {
  const rows = req.values.map((v) => {
    const moe =
      typeof v.marginOfError === 'number'
        ? ` plus or minus ${v.marginOfError}`
        : ' (no margin published)'
    const value = v.value === null ? 'no reportable value' : String(v.value)
    return `- ${v.key}: ${value}${moe}`
  })
  return [`Figure set: ${req.figureSetId}`, 'Figures:', ...rows].join('\n')
}

function contentOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  return typeof message?.content === 'string' ? message.content : null
}

/**
 * Transcription (Item 12, un-cut by the owner 2026-11-01: voice ships
 * because it works, per the standing ship-gate — see
 * docs/s12-voice-cut.md's reversal note). The model receives the audio
 * as an input_audio part and answers in a strict JSON envelope. Its
 * confidence is the model's own estimate, consumed only by the
 * clarify threshold in core/ai/mic.ts; the spoken-number gate and the
 * editable text box remain the reader-facing guards.
 */
export const TRANSCRIBE_SYSTEM_PROMPT =
  'You are the transcription helper for CivicScope, a housing-data tool. ' +
  'Transcribe the attached audio exactly as spoken: do not answer it, ' +
  'rephrase it, or add words that were not said. Report your confidence ' +
  'honestly — how certain you are that the transcript is word-perfect, ' +
  'especially any numbers, place names, and figures.'

export function transcriptJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['transcript', 'confidence'],
    properties: {
      transcript: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  }
}

/** Container format for the input_audio part, or null when unsupported. */
export function audioFormatForMime(mimeType: string): string | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  switch (base) {
    case 'audio/webm':
      return 'webm'
    case 'audio/mp4':
      return 'mp4'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    case 'audio/ogg':
      return 'ogg'
    default:
      return null
  }
}

/** Base64 for an ArrayBuffer, chunked; runs in the browser and the Worker. */
export function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Validate a transcription result from either provider path. */
export function parseTranscriptResult(value: unknown): TranscribeResult {
  const rec = value as { transcript?: unknown; confidence?: unknown } | null
  if (
    !rec ||
    typeof rec.transcript !== 'string' ||
    typeof rec.confidence !== 'number' ||
    !Number.isFinite(rec.confidence) ||
    rec.confidence < 0 ||
    rec.confidence > 1
  ) {
    throw new ProviderCallError('provider_down')
  }
  return { transcript: rec.transcript, confidence: rec.confidence }
}

/** Usage is read by the proxy adapter to settle the meter against reality. */
export function readUsage(body: unknown): { prompt: number; completion: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage
  if (!usage) return null
  return {
    prompt: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completion: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
  }
}

/**
 * Meta-direct provider. Used in two places, which is why it is separate from
 * the hybrid: the proxy's server side (one shared key, no recursion through
 * /api/muse) and the browser's BYO fallback (the visitor's own key).
 */
export function createMetaDirectProvider(options: MetaDirectOptions): MuseProvider {
  const doFetch: FetchLike = options.fetchImpl ?? ((...args) => fetch(...args))
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`

  async function completeOnce(body: Record<string, unknown>, signal: AbortSignal) {
    const key = options.getApiKey()
    if (!key) throw new ProviderCallError('bad_key')
    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: options.model, ...body }),
        signal,
        credentials: 'omit',
      })
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') throw e
      throw new ProviderCallError('provider_down')
    }
    const parsed = await res.json().catch(() => null)
    if (!res.ok) throw new ProviderCallError(mapMetaFailure(res.status, parsed))
    return parsed
  }

  /**
   * One completion, with exactly one retry on the two failure classes the
   * upstream was measured flapping on (2026-11-01, live against the portal):
   * the same key and the same request alternated between clean parses and
   * 401-class rejections in minute-scale windows, depending on the client
   * network — and each rejection also counted against the meter's circuit
   * breaker, stretching a bad window into a longer outage. A single retry
   * turns a per-attempt failure into a per-pair failure; a genuinely bad
   * key still surfaces after the second attempt, unchanged. Rate limits and
   * billing failures are never retried: waiting is the correct response to
   * the first, and the second will not heal inside one user action.
   */
  async function complete(body: Record<string, unknown>, signal: AbortSignal) {
    try {
      return await completeOnce(body, signal)
    } catch (e) {
      if (
        e instanceof ProviderCallError &&
        (e.code === 'bad_key' || e.code === 'provider_down') &&
        !signal.aborted
      ) {
        return completeOnce(body, signal)
      }
      throw e
    }
  }

  return {
    async intent(req, signal): Promise<IntentResult> {
      if (req.queryText && req.queryText.length > MAX_INTENT_QUERY_CHARS) {
        throw new ProviderCallError('shape_invalid')
      }
      const reply = await complete(
        {
          messages: [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: intentUserPrompt(req) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'CivicScopeIntent', strict: true, schema: intentJsonSchema() },
          },
          temperature: 0,
        },
        signal,
      )
      const text = contentOf(reply)
      if (!text) throw new ProviderCallError('provider_down')
      try {
        return { intent: JSON.parse(text) as IntentResult['intent'] }
      } catch {
        throw new ProviderCallError('shape_invalid')
      }
    },

    async explain(req, signal): Promise<ExplainResult> {
      const reply = await complete(
        {
          messages: [
            { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
            { role: 'user', content: explainUserPrompt(req) },
          ],
          temperature: 0.2,
        },
        signal,
      )
      const text = contentOf(reply)
      if (!text) throw new ProviderCallError('provider_down')
      return { prose: text.trim() }
    },

    async briefing(req: BriefingRequest, signal: AbortSignal): Promise<BriefingResult> {
      const reply = await complete(
        {
          messages: [
            { role: 'system', content: BRIEFING_SYSTEM_PROMPT },
            { role: 'user', content: briefingUserPrompt(req) },
          ],
          temperature: 0.2,
        },
        signal,
      )
      const text = contentOf(reply)
      if (!text) throw new ProviderCallError('provider_down')
      return { prose: text.trim() }
    },

    async transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult> {
      const format = audioFormatForMime(req.mimeType)
      if (!format) throw new ProviderCallError('shape_invalid')
      const reply = await complete(
        {
          messages: [
            { role: 'system', content: TRANSCRIBE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Transcribe the attached audio exactly as spoken.' },
                {
                  type: 'input_audio',
                  input_audio: { data: encodeBase64(req.audio), format },
                },
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'CivicScopeTranscript', strict: true, schema: transcriptJsonSchema() },
          },
          temperature: 0,
        },
        signal,
      )
      const text = contentOf(reply)
      if (!text) throw new ProviderCallError('provider_down')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new ProviderCallError('provider_down')
      }
      return parseTranscriptResult(parsed)
    },
  }
}

/**
 * The provider used by the product. Proxy first, BYO second, and a closed
 * error taxonomy out of both. It never returns empty prose as if it were an
 * answer: a withheld explanation is reported as withheld.
 */
export function createLiveProvider(options: LiveProviderOptions = {}): MuseProvider {
  const proxyBase = (options.proxyBase ?? '').replace(/\/$/, '')
  const doFetch: FetchLike = options.fetchImpl ?? ((...args) => fetch(...args))
  const direct = options.direct
    ? createMetaDirectProvider({ ...options.direct, fetchImpl: doFetch })
    : null

  /**
   * BYO is a visitor-key path, not a generic second attempt. The direct
   * provider is configured even for visitors who never stored a key; in that
   * state its first act is to throw bad_key, which would replace the proxy's
   * real shutdown or breaker answer with a sign-in claim. Measured live on
   * 2026-11-01: keyless browser sessions saw "could not sign in" during
   * breaker windows while the proxy itself had answered breaker_open. The
   * fallback is therefore available only when a key is actually retrievable.
   */
  const directKeyAvailable = (): boolean => {
    if (!options.direct) return false
    try {
      return Boolean(options.direct.getApiKey())
    } catch {
      return false
    }
  }

  async function viaProxy<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${proxyBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
        credentials: 'same-origin',
      })
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') throw e
      throw new ProviderCallError('provider_down')
    }
    const parsed = await res.json().catch(() => null)
    if (!res.ok) {
      const error = (parsed as { error?: unknown } | null)?.error
      const code: ProxyError = isProxyError(error)
        ? error
        : res.status === 429
          ? 'rate_limited'
          : 'provider_down'
      throw new ProviderCallError(code)
    }
    return parsed as T
  }

  return {
    async intent(req, signal): Promise<IntentResult> {
      if (req.queryText && req.queryText.length > MAX_INTENT_QUERY_CHARS) {
        throw new ProviderCallError('shape_invalid')
      }
      try {
        const reply = await viaProxy<{ intent?: unknown }>(
          '/api/muse/intent',
          { slots: req.slots, queryText: req.queryText },
          signal,
        )
        return { intent: reply.intent as IntentResult['intent'] }
      } catch (e) {
        const code = e instanceof ProviderCallError ? e.code : null
        if (!code || !BYO_FALLBACK_ERRORS.has(code) || !direct || !directKeyAvailable()) throw e
      }
      return direct.intent(req, signal)
    },

    async explain(req, signal): Promise<ExplainResult> {
      try {
        const reply = await viaProxy<ExplainResult>(
          '/api/muse/explain',
          { figureSetId: req.figureSetId, values: req.values },
          signal,
        )
        // The proxy withholds validator-failed prose; surface that state rather
        // than an empty string, so the UI can say "withheld" honestly. The
        // failure class travels as a closed enum so the client can count it
        // without ever seeing the refused prose.
        if (reply.withheld) {
          const failure = (reply as { failure?: unknown }).failure
          const withholdClass =
            typeof failure === 'string' &&
            (VALIDATOR_FAILURES as readonly string[]).includes(failure)
              ? (failure as ValidatorFailure)
              : undefined
          return withholdClass
            ? { prose: '', withheld: true, withholdClass }
            : { prose: '', withheld: true }
        }
        return reply
      } catch (e) {
        const code = e instanceof ProviderCallError ? e.code : null
        if (!code || !BYO_FALLBACK_ERRORS.has(code) || !direct || !directKeyAvailable()) throw e
      }
      return direct.explain(req, signal)
    },

    async briefing(req: BriefingRequest, signal: AbortSignal): Promise<BriefingResult> {
      try {
        const reply = await viaProxy<BriefingResult>(
          '/api/muse/briefing',
          { figureSetId: req.figureSetId, values: req.values },
          signal,
        )
        // Same withhold contract as explain: the proxy's validator refused
        // the prose, so the pack ships its figures without the wording.
        if (reply.withheld) {
          const failure = (reply as { failure?: unknown }).failure
          const withholdClass =
            typeof failure === 'string' &&
            (VALIDATOR_FAILURES as readonly string[]).includes(failure)
              ? (failure as ValidatorFailure)
              : undefined
          return withholdClass
            ? { prose: '', withheld: true, withholdClass }
            : { prose: '', withheld: true }
        }
        return reply
      } catch (e) {
        const code = e instanceof ProviderCallError ? e.code : null
        if (!code || !BYO_FALLBACK_ERRORS.has(code) || !direct || !directKeyAvailable()) throw e
      }
      return direct.briefing(req, signal)
    },

    async transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult> {
      try {
        const reply = await viaProxy<{ transcript?: unknown; confidence?: unknown }>(
          '/api/muse/transcribe',
          { mimeType: req.mimeType, audioBase64: encodeBase64(req.audio) },
          signal,
        )
        return parseTranscriptResult(reply)
      } catch (e) {
        const code = e instanceof ProviderCallError ? e.code : null
        if (!code || !BYO_FALLBACK_ERRORS.has(code) || !direct || !directKeyAvailable()) throw e
      }
      return direct.transcribe(req, signal)
    },
  }
}

/** True when a figure key can be sent for validation. Kept here so the client
 * and the proxy reject the same set. */
export function isExplainableKey(key: string): boolean {
  return isKnownFigureKey(key)
}
