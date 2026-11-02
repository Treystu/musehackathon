/**
 * POST /api/muse/intent — same-origin proxy route (House).
 * Shape validation, closed allowlist, query-length ceiling,
 * provider-breaker wait-out, and best-effort meter accounting
 * (accounting only since 2026-11-02: the meter never admits or
 * refuses a request). Counts only; no bodies, query text, IPs, or
 * keys are stored (Q1).
 * Framework-free handler so hermetic tests call it directly; the onRequestPost
 * export at the bottom is the thin HTTP adapter. The shared key lives
 * server-side only and is never sent to the browser.
 */
import { validateIntent } from '../../../src/core/ai/intent-schema'
import { resolveDomainClassification } from '../../../src/core/ai/general'
import { preCallGate, mapProviderError, attemptCall, accountCall, accountError, accountFailure, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute, type MuseEnv, type PagesContext } from '../../../src/server/muse-adapter'

export type { ProxyDeps } from '../../../src/server/muse-proxy'

const ALLOWED_PATHS = new Set(['/api/muse/intent'])
const MAX_QUERY_CHARS = 500
const FLAT_COST_MICRO = 1000
const FLAT_TOKENS_IN = 128
const FLAT_TOKENS_OUT = 64

export async function handleIntent(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  const slots = (body.slots ?? {}) as Record<string, unknown>
  if (typeof body.queryText === 'string' && body.queryText.length > MAX_QUERY_CHARS) {
    return err(400, 'shape_invalid', 'queryText exceeds ceiling')
  }
  try {
    const result = await attemptCall(deps, () =>
      deps.provider.intent(
        {
          slots: {
            geographyHints: Array.isArray(slots.geographyHints) ? (slots.geographyHints as string[]) : [],
            metricHints: Array.isArray(slots.metricHints) ? (slots.metricHints as string[]) : [],
          },
          queryText: typeof body.queryText === 'string' ? body.queryText : undefined,
          locale: 'en',
        },
        new AbortController().signal,
      ),
    )
    const check = validateIntent(result.intent)
    if (!check.ok) {
      accountError(deps, check.error)
      return { status: 422, body: { error: check.error, detail: check.detail } }
    }
    // The domain classification's deterministic guards (plan C13):
    // when the model supplied a classification, the guards may
    // correct it — current-events phrasing is never off-domain, a
    // servable place+measure reading prefers the data class — and
    // the corrected value is what rides the contract out. When the
    // model supplied none, the reply keeps its prior shape and
    // consumers apply the (a)-preference default themselves.
    const intent =
      check.intent.domain !== undefined
        ? {
            ...check.intent,
            domain: resolveDomainClassification(
              check.intent,
              typeof body.queryText === 'string' ? body.queryText : undefined,
            ).domain,
          }
        : check.intent
    // Counted only once the intent validates, as before — but as pure
    // accounting: best-effort, and never a condition of serving.
    accountCall(deps, req.clientId, FLAT_COST_MICRO, FLAT_TOKENS_IN, FLAT_TOKENS_OUT)
    return { status: 200, body: { intent } }
  } catch (e) {
    accountFailure(deps)
    const mapped = mapProviderError(e)
    accountError(deps, String(mapped.body.error))
    return mapped
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleIntent)
export type { MuseEnv, PagesContext }
