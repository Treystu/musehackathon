/**
 * Legacy mirror of the shared proxy machinery for /api/muse/*.
 * The routes import the live machinery from src/server/muse-proxy;
 * this module remains for the MeterDurableObject re-export below
 * (the worker bundle's binding needs it in this module graph) and
 * for the taxonomy helpers pinned by the meter-do tests. It is kept
 * semantically in step with the live gate: since 2026-11-02 the
 * meter is accounting only, so preCallGate here carries no budget or
 * cap refusal either. Closed error taxonomy — raw provider bodies
 * are never forwarded.
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

/** Pre-call gates: provider breaker and model allowlist. No budget
 *  or cap check — spend state is reporting data, not admission data. */
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
  if (deps.meter.breakerState() === 'open') return err(503, 'breaker_open')
  return null
}

/**
 * Map a meter persistence failure onto the closed taxonomy, for the
 * read paths that must not fabricate totals (diagnostics): a meter
 * that cannot be read answers 503 breaker_open. The request path
 * does not use this mapping any more — its meter writes are
 * best-effort accounting whose failure is invisible (2026-11-02).
 * Anything else is provider_down.
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
