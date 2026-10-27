/**
 * POST /api/muse/intent — same-origin proxy route (House slice).
 * Shape validation, allowlist, ceilings, meter, breaker. No content stored.
 * In the workbench this handler is framework-free so hermetic tests can call
 * it directly; the Pages Function wrapper at port time is a thin adapter.
 */
import { validateIntent } from '../../../src/core/ai/intent-schema'
import type { Meter } from '../../../src/core/ai/meter'
import type { MuseProvider } from '../../../src/core/ai/provider'

export type ProxyError =
  | 'not_allowlisted'
  | 'shape_invalid'
  | 'rate_limited'
  | 'credits_exhausted'
  | 'provider_down'
  | 'bad_key'
  | 'budget_exhausted'
  | 'breaker_open'

export interface ProxyDeps {
  meter: Meter
  provider: MuseProvider
  allowedModels: readonly string[]
}

const ALLOWED_PATHS = new Set(['/api/muse/intent'])

export async function handleIntent(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== 'POST' || !ALLOWED_PATHS.has(req.path)) {
    return { status: 400, body: { error: 'not_allowlisted' satisfies ProxyError } }
  }
  const body = req.body as Record<string, unknown> | null
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: 'shape_invalid' satisfies ProxyError } }
  }
  if (typeof body.model === 'string' && !deps.allowedModels.includes(body.model)) {
    return { status: 400, body: { error: 'not_allowlisted' satisfies ProxyError } }
  }
  if (deps.meter.snapshot().budgetExhausted) {
    return { status: 429, body: { error: 'budget_exhausted' satisfies ProxyError } }
  }
  if (deps.meter.breakerState() === 'open') {
    return { status: 503, body: { error: 'breaker_open' satisfies ProxyError } }
  }

  const slots = (body.slots ?? {}) as Record<string, unknown>
  const reservation = deps.meter.reserve(req.clientId, 1000, 512)
  if (!reservation) {
    return { status: 429, body: { error: 'budget_exhausted' satisfies ProxyError } }
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
      return { status: 422, body: { error: check.error, detail: check.detail } }
    }
    deps.meter.settle(reservation, req.clientId, 1000, 128, 64)
    return { status: 200, body: { intent: check.intent } }
  } catch {
    deps.meter.release(reservation)
    deps.meter.recordFailure()
    return { status: 502, body: { error: 'provider_down' satisfies ProxyError } }
  }
}
