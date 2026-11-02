/**
 * POST /api/muse/research — grounded web findings (2026-11-01, owner
 * directive: any question answerable). The Census data cannot serve
 * criteria like schools, amenities, or political character; this route
 * runs the Muse Responses API's web_search tool through the provider
 * and returns prose WITH its sources. The provider refuses ungrounded
 * replies (no citations), so a 200 from this route always carries a
 * source list. Settled at a conservative flat rate: web search bills
 * separately ($2.50 per 1,000 searches) on top of tokens, and the flat
 * 5,000 micro-USD covers both at demo scale against the judging
 * allowance. Counts only; no bodies are stored (Q1).
 */
import { MeterUnavailableError } from '../../../src/core/ai/meter-persistence'
import { preCallGate, mapMeterError, mapProviderError, attemptCall, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'

const ALLOWED_PATHS = new Set(['/api/muse/research'])
const MAX_QUERY_CHARS = 500
const MAX_PLACES = 8
const MAX_PLACE_CHARS = 120
const EST_COST_MICRO = 5000
const EST_TOKENS = 1024
const ACTUAL_COST_MICRO = 5000
const ACTUAL_TOKENS_IN = 256
const ACTUAL_TOKENS_OUT = 512

async function handleResearchCore(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate

  const body = req.body as Record<string, unknown>
  if (
    typeof body.queryText !== 'string' ||
    body.queryText.trim().length === 0 ||
    body.queryText.length > MAX_QUERY_CHARS
  ) {
    return err(400, 'shape_invalid', 'research needs a queryText within the ceiling')
  }
  let places: string[] = []
  if (body.places !== undefined) {
    if (
      !Array.isArray(body.places) ||
      body.places.length > MAX_PLACES ||
      body.places.some((p) => typeof p !== 'string' || p.length > MAX_PLACE_CHARS)
    ) {
      return err(400, 'shape_invalid', 'research places must be short strings')
    }
    places = body.places as string[]
  }

  const reservation = await deps.meter.reserve(req.clientId, EST_COST_MICRO, EST_TOKENS)
  if (!reservation) {
    await deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
  }

  try {
    const result = await attemptCall(deps, () =>
      deps.provider.research(
        { queryText: body.queryText as string, places },
        new AbortController().signal,
      ),
    )
    await deps.meter.settle(
      reservation,
      req.clientId,
      ACTUAL_COST_MICRO,
      ACTUAL_TOKENS_IN,
      ACTUAL_TOKENS_OUT,
    )
    if (
      typeof result.prose !== 'string' ||
      !result.prose.trim() ||
      !Array.isArray(result.sources) ||
      result.sources.length === 0
    ) {
      await deps.meter.recordError('provider_down')
      return err(502, 'provider_down', 'research returned no sourced findings')
    }
    return {
      status: 200,
      body: {
        prose: result.prose,
        sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
      },
    }
  } catch (e) {
    await deps.meter.release(reservation)
    await deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    await deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}

/** Exported handler; fails closed on meter unavailability, like its siblings. */
export async function handleResearch(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  try {
    return await handleResearchCore(req, deps)
  } catch (e) {
    if (e instanceof MeterUnavailableError) return mapMeterError(e)
    throw e
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleResearch)
