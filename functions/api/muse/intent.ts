/**
 * POST /api/muse/intent — same-origin proxy route (House).
 * Shape validation, closed allowlist, token ceilings, meter
 * reservation/settlement, breaker, hard shutoff at cap. Counts only;
 * no bodies, query text, IPs, or keys are stored (Q1).
 * Framework-free handler so hermetic tests call it directly; the onRequestPost
 * export at the bottom is the thin HTTP adapter. The shared key lives
 * server-side only and is never sent to the browser.
 */
import { validateIntent } from '../../../src/core/ai/intent-schema'
import { MeterUnavailableError } from '../../../src/core/ai/meter-persistence'
import { preCallGate, mapMeterError, mapProviderError, attemptCall, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute, type MuseEnv, type PagesContext } from '../../../src/server/muse-adapter'

export type { ProxyDeps } from '../../../src/server/muse-proxy'

const ALLOWED_PATHS = new Set(['/api/muse/intent'])
const MAX_QUERY_CHARS = 500
const EST_TOKENS = 512
const EST_COST_MICRO = 1000

async function handleIntentCore(
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
  const reservation = await deps.meter.reserve(req.clientId, EST_COST_MICRO, EST_TOKENS)
  if (!reservation) {
    await deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
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
      await deps.meter.release(reservation)
      await deps.meter.recordError(check.error)
      return { status: 422, body: { error: check.error, detail: check.detail } }
    }
    await deps.meter.settle(reservation, req.clientId, EST_COST_MICRO, 128, 64)
    return { status: 200, body: { intent: check.intent } }
  } catch (e) {
    await deps.meter.release(reservation)
    await deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    await deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}

/**
 * Exported handler: the core above settles against deps.meter, which in
 * the portal deployment is the Durable Object client. A meter that
 * cannot be read or written fails closed here — 503 breaker_open via
 * mapMeterError, and no unmetered provider call is made — instead of
 * surfacing as an unhandled error.
 */
export async function handleIntent(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  try {
    return await handleIntentCore(req, deps)
  } catch (e) {
    if (e instanceof MeterUnavailableError) return mapMeterError(e)
    throw e
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleIntent)
export type { MuseEnv, PagesContext }
