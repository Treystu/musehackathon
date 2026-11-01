/**
 * Shared proxy machinery for /api/muse/* (House).
 * Closed error taxonomy — raw provider bodies are never forwarded.
 * The counter store's logic core is src/core/ai/meter.ts (Meter class);
 * its persistence adapter is src/core/ai/meter-persistence.ts
 * (PersistentMeter over one durable record) with the Durable Object
 * binding in functions/api/muse/meter-do.ts (wrangler binding METER).
 * ProxyDeps.meter remains the synchronous Meter contract the
 * framework-free handlers call; at port time the handlers await the
 * DO-backed client (same op surface) and meter failures route through
 * mapMeterError — fail-closed, never an unmetered call.
 */
import type { Meter } from '../../../src/core/ai/meter'
import { MeterUnavailableError } from '../../../src/core/ai/meter-persistence'
import type { MuseProvider } from '../../../src/core/ai/provider'
import type { ProxyError } from '../../../src/core/ai/proxy-errors'

export interface ProxyDeps {
  meter: Meter
  provider: MuseProvider
  allowedModels: readonly string[]
}

export type ProxyReply = { status: number; body: Record<string, unknown> }

export function err(status: number, e: ProxyError, detail?: string): ProxyReply {
  return { status, body: detail ? { error: e, detail } : { error: e } }
}

/** Pre-call gates shared by every route: shutoff, breaker, model allowlist. */
export function preCallGate(
  req: { method: string; body: unknown },
  deps: ProxyDeps,
  allowedPaths: ReadonlySet<string>,
  path: string,
): ProxyReply | null {
  if (req.method !== 'POST' || !allowedPaths.has(path)) return err(400, 'not_allowlisted')
  const body = req.body as Record<string, unknown> | null
  if (typeof body !== 'object' || body === null) return err(400, 'shape_invalid')
  if (typeof body.model === 'string' && !deps.allowedModels.includes(body.model)) {
    return err(400, 'not_allowlisted')
  }
  if (deps.meter.snapshot().budgetExhausted) return err(429, 'budget_exhausted')
  if (deps.meter.breakerState() === 'open') return err(503, 'breaker_open')
  return null
}

/**
 * Map a meter persistence failure onto the closed taxonomy. A meter
 * that cannot be read or written fails closed as 503 breaker_open:
 * the AI surface degrades exactly as it does on an open breaker, and
 * no unmetered provider call is made. Anything else is provider_down.
 */
export function mapMeterError(e: unknown): ProxyReply {
  if (e instanceof MeterUnavailableError) return err(503, 'breaker_open')
  return err(502, 'provider_down')
}

/** Map a thrown provider failure onto the closed taxonomy. */
export function mapProviderError(e: unknown): ProxyReply {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'rate_limited') return err(429, 'rate_limited')
  if (code === 'credits_exhausted') return err(429, 'credits_exhausted')
  if (code === 'bad_key') return err(401, 'bad_key')
  return err(502, 'provider_down')
}

/**
 * Union addition (Panel B1, per Panel B2's deploy precondition): the
 * Pages worker bundle must re-export the meter Durable Object class so
 * the METER binding in wrangler.toml can attach. meter-do.ts was
 * written expecting this re-export at port time.
 */
export { MeterDurableObject } from './meter-do'
