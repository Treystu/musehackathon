/**
 * POST /api/muse/flexible — the flexible completion lane's draft
 * route (2026-11-02, owner directive: flexible completion for the
 * research-mismatch terminal; Jev gate PROCEED-with-note, the note
 * being the structural safeguards client-side in
 * src/core/ai/flexible.ts).
 *
 * Spark drafts the completion from the evidence packet the strict
 * pipeline gathered (question, stated criteria, the places the
 * cited research named, the cited findings, the sources) under the
 * closed JSON contract buildFlexiblePacketText states. This route
 * judges nothing about the draft: it returns the model's JSON
 * object, and the client's closed-schema parser plus the extended
 * deterministic validator decide whether any of it may render —
 * the same division the bookend routes keep (the route serves a
 * stage call; deterministic code owns the verdict). Every failure
 * shape here is a labelled degradation in a 200 reply
 * ({ outcome: 'degraded' }), never a fabricated draft: the client
 * then keeps the strict lane's honest note.
 *
 * Settles at the flat per-stage constant, like the general route
 * (a single-purpose Spark call, C11 pattern). Counts only (Q1).
 */
import { MUSE_SPARK_MODEL } from '../../../src/core/ai/meta-client'
import {
  buildFlexiblePacketText,
  FLEXIBLE_MAX_CLAIM_CHARS,
  FLEXIBLE_MAX_CLAIMS,
  FLEXIBLE_MAX_CRITERIA,
  FLEXIBLE_MAX_DRAFT_TEXT_CHARS,
  FLEXIBLE_MAX_GAPS,
  FLEXIBLE_MAX_GAP_CHARS,
  FLEXIBLE_MAX_PLACES,
  FLEXIBLE_MAX_QUESTION_CHARS,
  FLEXIBLE_MAX_SOURCES,
  FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM,
  FLEXIBLE_MAX_SOURCE_URL_CHARS,
  type FlexibleDraftRequest,
} from '../../../src/core/ai/flexible'
import {
  preCallGate,
  accountCall,
  accountError,
  err,
  type ProxyDeps,
  type ProxyReply,
} from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'
import { withStageTimeout } from './plan'

const ALLOWED_PATHS = new Set(['/api/muse/flexible'])
/** Flat settle for this stage (the general route's class, C11 pattern). */
export const FLEXIBLE_SETTLE_MICRO_USD = 2000
/** A full structured draft is a longer stage call than a bookend verdict. */
export const FLEXIBLE_TIMEOUT_MS = 40_000
const FLAT_TOKENS_IN = 512
const FLAT_TOKENS_OUT = 512

// The packet limits are the shared contract constants in
// src/core/ai/flexible.ts, not local literals: the client
// construction conforms to the same values before sending, so the
// two sides cannot drift into a refusal again (the drift here —
// construction sending gathered material past these caps — was
// measured 2026-11-03 as the flexible lane's zero-match refusal).
const MAX_QUESTION_CHARS = FLEXIBLE_MAX_QUESTION_CHARS
const MAX_CRITERIA = FLEXIBLE_MAX_CRITERIA
const MAX_PLACES = FLEXIBLE_MAX_PLACES
const MAX_CLAIMS = FLEXIBLE_MAX_CLAIMS
const MAX_CLAIM_CHARS = FLEXIBLE_MAX_CLAIM_CHARS
const MAX_SOURCES = FLEXIBLE_MAX_SOURCES
const MAX_DRAFT_TEXT_CHARS = FLEXIBLE_MAX_DRAFT_TEXT_CHARS
const MAX_GAPS = FLEXIBLE_MAX_GAPS
const MAX_GAP_CHARS = FLEXIBLE_MAX_GAP_CHARS

const SYSTEM_PROMPT =
  'You complete a data-tool answer whose cited research named places that could not be ' +
  'matched to the dataset. You see only the evidence packet. Answer the question ' +
  'completely from the findings and your own knowledge, following the output contract ' +
  'and evidence-basis rules in the packet exactly. Return only the JSON object.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringList(value: unknown, max: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxChars) return null
    out.push(entry)
  }
  return out
}

function parseInput(body: Record<string, unknown>): FlexibleDraftRequest | null {
  if (
    typeof body.question !== 'string' ||
    body.question.length === 0 ||
    body.question.length > MAX_QUESTION_CHARS
  ) {
    return null
  }
  const criteria = stringList(body.criteria ?? [], MAX_CRITERIA, 200)
  if (!criteria) return null
  const researchPlaces = stringList(body.researchPlaces ?? [], MAX_PLACES, 200)
  if (!researchPlaces) return null
  if (!Array.isArray(body.claims) || body.claims.length > MAX_CLAIMS) return null
  const claims: { text: string; sourceUrls: string[] }[] = []
  for (const entry of body.claims) {
    if (!isRecord(entry) || typeof entry.text !== 'string') return null
    if (entry.text.length === 0 || entry.text.length > MAX_CLAIM_CHARS) return null
    const urls = stringList(
      entry.sourceUrls ?? [],
      FLEXIBLE_MAX_SOURCE_URLS_PER_CLAIM,
      FLEXIBLE_MAX_SOURCE_URL_CHARS,
    )
    if (!urls) return null
    claims.push({ text: entry.text, sourceUrls: urls })
  }
  if (!Array.isArray(body.sources) || body.sources.length > MAX_SOURCES) return null
  const sources: { title: string; url: string }[] = []
  for (const entry of body.sources) {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.url !== 'string') {
      return null
    }
    sources.push({ title: entry.title, url: entry.url })
  }
  let revision: FlexibleDraftRequest['revision']
  if (body.revision !== undefined) {
    if (!isRecord(body.revision)) return null
    const { draftText, gaps } = body.revision
    if (
      typeof draftText !== 'string' ||
      draftText.length === 0 ||
      draftText.length > MAX_DRAFT_TEXT_CHARS
    ) {
      return null
    }
    const gapList = stringList(gaps, MAX_GAPS, MAX_GAP_CHARS)
    if (!gapList) return null
    revision = { draftText, gaps: gapList }
  }
  return {
    question: body.question,
    criteria,
    researchPlaces,
    claims,
    sources,
    ...(revision ? { revision } : {}),
  }
}

export async function handleFlexible(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  const input = parseInput(body)
  if (!input) return err(400, 'shape_invalid', 'flexible needs question, criteria, researchPlaces, claims, and sources')
  const model = typeof body.model === 'string' ? body.model : MUSE_SPARK_MODEL
  const started = Date.now()
  if (!deps.stageProvider) {
    return { status: 200, body: { outcome: 'degraded', model } }
  }
  try {
    const result = await withStageTimeout(FLEXIBLE_TIMEOUT_MS, (signal) =>
      deps.stageProvider!.stageChat(
        { model, system: SYSTEM_PROMPT, user: buildFlexiblePacketText(input) },
        signal,
      ),
    )
    accountCall(deps, req.clientId, FLEXIBLE_SETTLE_MICRO_USD, FLAT_TOKENS_IN, FLAT_TOKENS_OUT, {
      model: result.model ?? model,
      route: 'flexible',
    })
    let draft: unknown = null
    try {
      draft = JSON.parse(result.text)
    } catch {
      draft = null
    }
    if (!isRecord(draft)) {
      // Unparseable model output is a degradation, never a partial
      // trust: the client keeps the strict terminal.
      accountError(deps, 'shape_invalid')
      return {
        status: 200,
        body: { outcome: 'degraded', model: result.model, latencyMs: Date.now() - started },
      }
    }
    return {
      status: 200,
      body: { outcome: 'draft', draft, model: result.model, latencyMs: Date.now() - started },
    }
  } catch {
    // Timeout or provider failure: the draft did not happen, and
    // the reply says exactly that.
    accountError(deps, 'provider_down')
    return {
      status: 200,
      body: { outcome: 'degraded', model, latencyMs: Date.now() - started },
    }
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleFlexible)
