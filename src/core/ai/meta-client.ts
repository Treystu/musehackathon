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
  ResearchRequest,
  ResearchResult,
  TranscribeRequest,
  TranscribeResult,
} from './provider'
import { PROXY_ERRORS, type ProxyError } from './proxy-errors'
import { VALIDATOR_FAILURES, findBannedConstruction, type ValidatorFailure } from './validator'

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
  'Never claim a difference is real when the margins of error overlap. Refer to each place by the',
  'name printed before its figures, and do not write any number that is not one of',
  'the supplied figures. Plain prose only.',
].join(' ')

const BRIEFING_SYSTEM_PROMPT = [
  'You write the narrative for a briefing pack whose figures were already retrieved by a',
  'deterministic data tool and re-verified against their sources before you were called.',
  'Write a short plain paragraph about what the supplied figures show, for a reader who',
  'will use the pack to brief other people. Use only numbers that appear in the supplied',
  'figures. Do not compute or introduce any number. Do not rank places, recommend a place,',
  'or describe people. Do not call any place good, bad, safe, or desirable. If a margin of',
  'error is wide relative to the figure, say the estimate is uncertain. Never claim a',
  'difference is real when the margins of error overlap. Refer to each place by the',
  'name printed before its figures, and do not write any number that is not one of',
  'the supplied figures. Plain prose only.',
].join(' ')

function briefingUserPrompt(req: BriefingRequest): string {
  const rows = req.values.map((v) => {
    const moe =
      typeof v.marginOfError === 'number'
        ? ` plus or minus ${v.marginOfError}`
        : ' (no margin published)'
    const value = v.value === null ? 'no reportable value' : String(v.value)
    // Name the place by its label only. A raw ZIP here is a numeral
    // the figure validator cannot tell from an invented figure, and
    // prose repeating it was withheld (found live 2026-11-01).
    const place = v.label ? `${v.label} — ` : ''
    return `- ${place}${v.key}: ${value}${moe}`
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
    // Name the place by its label only, exactly as the briefing prompt
    // does. A raw ZIP here is a numeral the figure validator cannot
    // tell from an invented figure.
    const place = v.label ? `${v.label} — ` : ''
    return `- ${place}${v.key}: ${value}${moe}`
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
 * docs/s12-voice-cut.md's reversal note). Muse Spark takes no audio
 * input at all — measured live 2026-11-01: an input_audio chat part
 * is silently ignored and the model honestly reports an empty
 * transcript. Transcription belongs to the dedicated Muse Voice
 * Transcribe model on its own endpoint, POST /v1/asr/transcribe:
 * multipart with a JSON `request` part (mode/model/audioEncoding)
 * and the `audio` part, accepting exactly one shape — mono 16-bit
 * PCM WAV at 16 or 24 kHz — which is why the mic converts the
 * browser's recording to that shape before sending (MicInput).
 * The service returns no confidence score (documented), so a
 * returned transcript is taken at face value (confidence 1) and an
 * empty one as unusable (0); the spoken-number gate in core/ai/mic.ts
 * and the editable text box remain the reader-facing guards.
 */
export const ASR_MODEL = 'muse-voice-transcribe-1.0'

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

/**
 * Grounded web research (2026-11-01, owner directive). Search
 * grounding exists ONLY on the Responses API — the Chat Completions
 * endpoint rejects it (documented; the chat path above cannot carry
 * it). The Responses call names the web_search tool and asks for all
 * consulted results; the answer's url_citation annotations are the
 * sources the reader sees. A reply with no citations is not a
 * research result: parseResearchResult returns the sources it found
 * and the provider refuses an empty list, because presenting
 * unsourced prose as web findings would break the product's sourcing
 * discipline.
 */
export const RESEARCH_SYSTEM_PROMPT =
  'You are the web-research helper for CivicScope, a housing-data tool whose ' +
  'figures come from the US Census Bureau. The places named in the request ' +
  'were already screened by deterministic code against the reader\'s Census ' +
  'criteria (rent, income, rent burden, home value): every named place is ' +
  'known to meet those criteria, and places that did not meet them are not ' +
  'named. Research ONLY the named places, and only against the parts of the ' +
  'reader question that Census data cannot cover: schools, amenities and ' +
  'businesses nearby, safety, political character, lifestyle, services, and ' +
  'local context. For each named place, report what sources say about those ' +
  'remaining criteria, and name plainly the places that meet ALL of the ' +
  'reader\'s criteria — the Census-screened ones and the ones you researched. ' +
  'Be tight and factual: short paragraphs or a ' +
  'short list. Cite the pages you rely on. Never invent a statistic or a ' +
  'rating; if the web does not support part of the answer, say so plainly. ' +
  'Do not state rent, home-value, income, or demographic figures — those are ' +
  'shown separately from Census data and must never come from the web. ' +
  'Report what sources say about the criteria the reader asked about; do ' +
  'not characterize places by race, ethnicity, religion, or national ' +
  'origin, and do not rank or steer readers toward or away from places by ' +
  'who lives there.'

export interface ResearchSourceLike {
  title: string
  url: string
}

/** Parse a Responses API research reply into prose + deduped sources. */
export function parseResearchResult(value: unknown): { prose: string; sources: ResearchSourceLike[] } {
  const out: string[] = []
  const byUrl = new Map<string, ResearchSourceLike>()
  const addSource = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return
    if (byUrl.has(url) || byUrl.size >= 8) return
    byUrl.set(url, { url, title: typeof title === 'string' && title.trim() ? title.trim() : url })
  }
  const root = value as { output?: unknown } | null
  const items = Array.isArray(root?.output) ? root.output : []
  // Muse Spark narrates before it searches ("I'll research ..."), in
  // a message that precedes the search call. That narration is process,
  // not the answer: when a search happened, only message text after
  // the first search call is answer prose.
  const firstSearchAt = items.findIndex(
    (i) => (i as { type?: unknown } | null)?.type === 'web_search_call',
  )
  for (const [index, item] of (items as Array<Record<string, unknown>>).entries()) {
    if (item?.type === 'web_search_call') {
      const results = (item as { results?: unknown }).results
      if (Array.isArray(results)) {
        for (const r of results as Array<Record<string, unknown>>) addSource(r?.url, r?.title)
      }
      continue
    }
    if (item?.type !== 'message') continue
    if (firstSearchAt >= 0 && index < firstSearchAt) continue
    const parts = Array.isArray(item.content) ? item.content : []
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type !== 'output_text' || typeof part.text !== 'string') continue
      out.push(part.text)
      const annotations = Array.isArray(part.annotations) ? part.annotations : []
      for (const a of annotations as Array<Record<string, unknown>>) {
        if (a?.type === 'url_citation') addSource(a.url, a.title)
      }
    }
  }
  return { prose: out.join('\n\n').trim(), sources: [...byUrl.values()] }
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

  /**
   * One Responses API call (research lives there; see the note at
   * RESEARCH_SYSTEM_PROMPT), with the same single-retry posture as
   * complete().
   */
  async function respondOnce(body: Record<string, unknown>, signal: AbortSignal) {
    const key = options.getApiKey()
    if (!key) throw new ProviderCallError('bad_key')
    let res: Response
    try {
      res = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer '.concat(key),
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

  async function respond(body: Record<string, unknown>, signal: AbortSignal) {
    try {
      return await respondOnce(body, signal)
    } catch (e) {
      if (
        e instanceof ProviderCallError &&
        (e.code === 'bad_key' || e.code === 'provider_down') &&
        !signal.aborted
      ) {
        return respondOnce(body, signal)
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

    async research(req: ResearchRequest, signal: AbortSignal): Promise<ResearchResult> {
      const places =
        req.places && req.places.length > 0
          ? `\nPlaces the question names: ${req.places.join(', ')}`
          : ''
      const reply = await respond(
        {
          input: [
            { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
            { role: 'user', content: `Question: ${req.queryText}${places}` },
          ],
          tools: [{ type: 'web_search', search_context_size: 'medium' }],
          include: ['web_search_call.results'],
          temperature: 0.3,
        },
        signal,
      )
      const { prose, sources } = parseResearchResult(reply)
      // The citation gate: ungrounded prose is not a research result.
      if (!prose || sources.length === 0) throw new ProviderCallError('provider_down')
      // The fair-housing gate (2026-11-02): the banned-construction
      // scan applies to research prose on this direct path too (the
      // proxy route re-checks it and records the class; here the
      // failure lands on the same unavailable state the UI already
      // uses for ungrounded research, rather than rendering prose
      // the figure surfaces would have withheld). Criteria-grounded
      // context (rescoped 2026-11-02): the prose names screened
      // places against the reader's stated criteria; protected-class
      // steering, recommendation, and superlatives still withhold.
      if (findBannedConstruction(prose, { criteriaGrounded: true })) {
        throw new ProviderCallError('provider_down')
      }
      return { prose, sources }
    },

    async transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult> {
      // The ASR endpoint accepts mono PCM WAV only; anything else is
      // a shape failure here rather than a bare 400 upstream. The mic
      // converts before sending, so production traffic is WAV.
      if (audioFormatForMime(req.mimeType) !== 'wav') {
        throw new ProviderCallError('shape_invalid')
      }
      const attempt = async (): Promise<TranscribeResult> => {
        const key = options.getApiKey()
        if (!key) throw new ProviderCallError('bad_key')
        const form = new FormData()
        form.append(
          'request',
          new Blob(
            [
              JSON.stringify({
                mode: 'ENDPOINTING',
                model: ASR_MODEL,
                audioEncoding: 'WAV',
                languageBias: ['English'],
              }),
            ],
            { type: 'application/json' },
          ),
        )
        form.append('audio', new Blob([req.audio], { type: 'audio/wav' }), 'audio.wav')
        let res: Response
        try {
          res = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/asr/transcribe`, {
            method: 'POST',
            headers: { accept: 'application/json', authorization: 'Bearer '.concat(key) },
            body: form,
            signal,
            credentials: 'omit',
          })
        } catch (e) {
          if ((e as { name?: string } | null)?.name === 'AbortError') throw e
          throw new ProviderCallError('provider_down')
        }
        const parsed = (await res.json().catch(() => null)) as {
          transcript?: unknown
        } | null
        if (!res.ok) throw new ProviderCallError(mapMetaFailure(res.status, parsed))
        const transcript =
          typeof parsed?.transcript === 'string' ? parsed.transcript.trim() : ''
        // No confidence exists upstream (documented); see the note at
        // ASR_MODEL. Empty transcript = nothing heard = unusable.
        return { transcript, confidence: transcript ? 1 : 0 }
      }
      try {
        return await attempt()
      } catch (e) {
        // Same single-retry posture as complete(): the upstream flaps.
        if (
          e instanceof ProviderCallError &&
          (e.code === 'bad_key' || e.code === 'provider_down') &&
          !signal.aborted
        ) {
          return attempt()
        }
        throw e
      }
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

    async research(req: ResearchRequest, signal: AbortSignal): Promise<ResearchResult> {
      try {
        const reply = await viaProxy<{ prose?: unknown; sources?: unknown }>(
          '/api/muse/research',
          { queryText: req.queryText, places: req.places ?? [] },
          signal,
        )
        return parseResearchReply(reply)
      } catch (e) {
        const code = e instanceof ProviderCallError ? e.code : null
        if (!code || !BYO_FALLBACK_ERRORS.has(code) || !direct || !directKeyAvailable()) throw e
      }
      return direct.research(req, signal)
    },
  }
}

/** Validate the research route's reply: prose plus a non-empty source list. */
export function parseResearchReply(value: unknown): ResearchResult {
  const rec = value as { prose?: unknown; sources?: unknown } | null
  const sources: ResearchResult['sources'] = []
  if (Array.isArray(rec?.sources)) {
    for (const s of rec.sources as Array<{ title?: unknown; url?: unknown }>) {
      if (typeof s?.url === 'string' && /^https?:\/\//.test(s.url)) {
        sources.push({
          url: s.url,
          title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : s.url,
        })
      }
    }
  }
  if (!rec || typeof rec.prose !== 'string' || !rec.prose.trim() || sources.length === 0) {
    throw new ProviderCallError('provider_down')
  }
  // Client re-check of the route's fair-housing gate, mirroring the
  // explain path's double enforcement: a reply carrying a banned
  // construction (or a withheld flag from a gated deployment) never
  // reaches the render. Same criteria-grounded context as the route.
  if (findBannedConstruction(rec.prose, { criteriaGrounded: true })) {
    throw new ProviderCallError('provider_down')
  }
  return { prose: rec.prose.trim(), sources }
}

/** True when a figure key can be sent for validation. Kept here so the client
 * and the proxy reject the same set. */
export function isExplainableKey(key: string): boolean {
  return isKnownFigureKey(key)
}
