/**
 * POST /api/muse/general — the general lane's answer route (plan
 * C13, beat 1). Spark answers a genuinely off-domain question from
 * its own knowledge through the same metered proxy as every other
 * stage: shape validation, closed allowlist, provider-breaker
 * wait-out, best-effort accounting only (the meter never admits or
 * refuses; 2026-11-02 posture).
 *
 * VALIDATOR SEPARATION, explicit: unlike the explain and briefing
 * routes, this handler NEVER runs the figure-provenance validator
 * (src/core/ai/validator) over the reply. General prose is a
 * distinct prose class — its numerals are the model's own estimates,
 * not retrieved figures — so invented_numeral has no jurisdiction
 * here and a general answer cannot be withheld by it. The general
 * lane's own verification is the deterministic arithmetic check plus
 * the J-GEN loop, both client-side in the general runner. The mirror
 * rule also holds: nothing on this route can produce a data answer
 * or the Census label; it returns model prose only, and the client
 * renders it under the general label line alone.
 * Counts only; no bodies are stored (Q1).
 */
import type { GeneralRequest } from '../../../src/core/ai/provider'
import { preCallGate, mapProviderError, attemptCall, accountCall, accountError, accountFailure, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'

const ALLOWED_PATHS = new Set(['/api/muse/general'])
const MAX_QUERY_CHARS = 500
const MAX_REVISION_CHARS = 4000
const MAX_GAPS = 8
/** Flat settle: a single-purpose Spark call, the bookend stages' class (C11 pattern). */
const ACTUAL_COST_MICRO = 2000
const ACTUAL_TOKENS_IN = 256
const ACTUAL_TOKENS_OUT = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseGeneralRequest(body: Record<string, unknown>): GeneralRequest | null {
  if (
    typeof body.queryText !== 'string' ||
    body.queryText.length === 0 ||
    body.queryText.length > MAX_QUERY_CHARS
  ) {
    return null
  }
  const req: GeneralRequest = { queryText: body.queryText }
  if (body.revision !== undefined) {
    if (!isRecord(body.revision)) return null
    const { answerText, gaps } = body.revision
    if (
      typeof answerText !== 'string' ||
      answerText.length === 0 ||
      answerText.length > MAX_REVISION_CHARS ||
      !Array.isArray(gaps) ||
      gaps.length > MAX_GAPS ||
      gaps.some((g) => typeof g !== 'string' || g.length === 0 || g.length > 300)
    ) {
      return null
    }
    req.revision = { answerText, gaps: gaps as string[] }
  }
  return req
}

export async function handleGeneral(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate

  const body = req.body as Record<string, unknown>
  const parsed = parseGeneralRequest(body)
  if (!parsed) return err(400, 'shape_invalid', 'general needs queryText')

  try {
    const result = await attemptCall(deps, () =>
      deps.provider.general(parsed, new AbortController().signal),
    )
    accountCall(deps, req.clientId, ACTUAL_COST_MICRO, ACTUAL_TOKENS_IN, ACTUAL_TOKENS_OUT)
    if (typeof result.prose !== 'string' || !result.prose.trim()) {
      accountError(deps, 'provider_down')
      return err(502, 'provider_down', 'provider returned no prose')
    }
    // No validator call here — see the header. The prose ships as
    // the model's own answer; the client labels it as such.
    return { status: 200, body: { prose: result.prose } }
  } catch (e) {
    accountFailure(deps)
    const mapped = mapProviderError(e)
    accountError(deps, String(mapped.body.error))
    return mapped
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleGeneral)
export type { MuseEnv, PagesContext } from '../../../src/server/muse-adapter'
