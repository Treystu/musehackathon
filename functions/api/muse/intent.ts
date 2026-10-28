/**
 * POST /api/muse/intent — same-origin proxy route (House).
 * Shape validation, closed allowlist, token ceilings, meter
 * reservation/settlement, breaker, hard shutoff at cap. Counts only;
 * no bodies, query text, IPs, or keys are stored (Q1).
 * Framework-free handler so hermetic tests call it directly; the Pages
 * Function wrapper at port time is a thin adapter. The shared key lives
 * server-side only and is never sent to the browser.
 */
import { validateIntent } from '../../../src/core/ai/intent-schema'
import { preCallGate, mapProviderError, err, type ProxyDeps, type ProxyReply } from './shared'

export type { ProxyDeps } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/intent'])
const MAX_QUERY_CHARS = 500
const EST_TOKENS = 512
const EST_COST_MICRO = 1000

export async function handleIntent(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  const slots = (body.slots ?? {}) as Record<string, unknown>
  if (typeof body.queryText === 'string' && body.queryText.length > MAX_QUERY_CHARS) {
    return err(400, 'shape_invalid', 'queryText exceeds ceiling')
  }
  const reservation = deps.meter.reserve(req.clientId, EST_COST_MICRO, EST_TOKENS)
  if (!reservation) {
    deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
  }
  try {
    const result = await deps.provider.intent(
      {
        slots: {
          geographyHints: Array.isArray(slots.geographyHints) ? (slots.geographyHints as string[]) : [],
          metricHints: Array.isArray(slots.metricHints) ? (slots.metricHints as string[]) : [],
        },
        queryText: typeof body.queryText === 'string' ? body.queryText : undefined,
        locale: 'en',
      },
      new AbortController().signal,
    )
    const check = validateIntent(result.intent)
    if (!check.ok) {
      deps.meter.release(reservation)
      deps.meter.recordError(check.error)
      return { status: 422, body: { error: check.error, detail: check.detail } }
    }
    deps.meter.settle(reservation, req.clientId, EST_COST_MICRO, 128, 64)
    return { status: 200, body: { intent: check.intent } }
  } catch (e) {
    deps.meter.release(reservation)
    deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}
