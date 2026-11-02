/**
 * POST /api/muse/verify — bottom bookend: Wonder answer
 * verification (C5, 2026-11-02). Runs after the Jev loop settles,
 * before display: the caller sends the composed answer's structured
 * state, this route builds the condensed P2 packet (budget 2,500
 * tokens, hard-trimmed) and asks the stage model for the
 * closed-schema verdict. The reply's `wonder` field is the labeling
 * contract: 'verified' or 'concerns' only when a verdict actually
 * ran; 'not-run' (timeout, error, unreachable model) claims nothing.
 * Deterministic verify owns figures and citations regardless of
 * what this route answers. Settles flat (C11). Counts only (Q1).
 */
import { MUSE_WONDER_MODEL } from '../../../src/core/ai/meta-client'
import {
  buildVerifyPacket,
  parseVerifyVerdict,
  type VerifyPacketInput,
} from '../../../src/core/ai/hourglass-packets'
import { recordBottomBookend } from '../../../src/core/ai/bookend-counters'
import {
  preCallGate,
  accountCall,
  accountBottomBookend,
  accountError,
  err,
  type ProxyDeps,
  type ProxyReply,
} from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'
import { withStageTimeout } from './plan'

const ALLOWED_PATHS = new Set(['/api/muse/verify'])
/** Flat settle for this stage (plan annex C11, exact). */
export const VERIFY_SETTLE_MICRO_USD = 2000
/** Hard client timeout for the bottom bookend call (plan C5, exact). */
export const VERIFY_TIMEOUT_MS = 25_000
const FLAT_TOKENS_IN = 640
const FLAT_TOKENS_OUT = 192

const SYSTEM_PROMPT =
  'You verify a composed answer against its condensed evidence packet. ' +
  'Reply with one JSON object: {"verdict":"verified","concerns":[]} when the ' +
  'answer matches its evidence, {"verdict":"concerns","concerns":[{"kind":' +
  '"factual"|"presentational","detail":"..."}]} for named problems short of ' +
  'failure, or {"verdict":"not_verified","concerns":[...]} when the answer ' +
  'does not match its evidence. Return only the JSON object.'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseInput(body: Record<string, unknown>): VerifyPacketInput | null {
  if (typeof body.answerText !== 'string' || body.answerText.length === 0) return null
  if (!Array.isArray(body.places) || body.places.some((p) => typeof p !== 'string')) return null
  if (!Array.isArray(body.criteriaEvidence)) return null
  const criteriaEvidence: VerifyPacketInput['criteriaEvidence'] = []
  for (const c of body.criteriaEvidence) {
    if (!isRecord(c) || typeof c.criterion !== 'string' || typeof c.label !== 'string') return null
    criteriaEvidence.push({ criterion: c.criterion, label: c.label })
  }
  if (!Array.isArray(body.sources)) return null
  const sources: VerifyPacketInput['sources'] = []
  for (const s of body.sources) {
    if (!isRecord(s) || typeof s.title !== 'string' || typeof s.url !== 'string') return null
    sources.push({ title: s.title, url: s.url })
  }
  if (typeof body.verifySummary !== 'string') return null
  return {
    answerText: body.answerText,
    places: body.places as string[],
    criteriaEvidence,
    sources,
    verifySummary: body.verifySummary,
  }
}

export async function handleVerify(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  const input = parseInput(body)
  if (!input) return err(400, 'shape_invalid', 'verify needs answerText, places, criteriaEvidence, sources, verifySummary')
  const packet = buildVerifyPacket(input)
  const model = typeof body.model === 'string' ? body.model : MUSE_WONDER_MODEL
  const started = Date.now()
  if (!deps.stageProvider) {
    recordBottomBookend('notRun')
    accountBottomBookend(deps, 'notRun')
    return {
      status: 200,
      body: { wonder: 'not-run', outcome: 'degraded', model, packetTokens: packet.tokens, trimmed: packet.trimmed },
    }
  }
  try {
    const result = await withStageTimeout(VERIFY_TIMEOUT_MS, (signal) =>
      deps.stageProvider!.stageChat({ model, system: SYSTEM_PROMPT, user: packet.text }, signal),
    )
    // P7: bucket by the provider-reported model, as in plan.ts.
    accountCall(deps, req.clientId, VERIFY_SETTLE_MICRO_USD, FLAT_TOKENS_IN, FLAT_TOKENS_OUT, {
      model: result.model ?? model,
      route: 'verify',
    })
    const verdict = parseVerifyVerdict(result.text)
    const latencyMs = Date.now() - started
    if (verdict.kind === 'verified') {
      recordBottomBookend('verified')
      accountBottomBookend(deps, 'verified')
      return { status: 200, body: { wonder: 'verified', outcome: 'verified', concerns: [], model: result.model, latencyMs, packetTokens: packet.tokens, trimmed: packet.trimmed } }
    }
    if (verdict.kind === 'concerns' || verdict.kind === 'not_verified') {
      recordBottomBookend('concerns')
      accountBottomBookend(deps, 'concerns')
      return {
        status: 200,
        body: {
          wonder: 'concerns',
          outcome: verdict.kind,
          concerns: verdict.concerns,
          model: result.model,
          latencyMs,
          packetTokens: packet.tokens,
          trimmed: packet.trimmed,
        },
      }
    }
    recordBottomBookend('notRun')
    accountBottomBookend(deps, 'notRun')
    accountError(deps, 'shape_invalid')
    return { status: 200, body: { wonder: 'not-run', outcome: 'degraded', model: result.model, latencyMs, packetTokens: packet.tokens, trimmed: packet.trimmed } }
  } catch {
    recordBottomBookend('notRun')
    accountBottomBookend(deps, 'notRun')
    accountError(deps, 'provider_down')
    return {
      status: 200,
      body: { wonder: 'not-run', outcome: 'degraded', model, latencyMs: Date.now() - started, packetTokens: packet.tokens, trimmed: packet.trimmed },
    }
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleVerify)
