/**
 * Shared proxy machinery for /api/muse/* (House).
 * Closed error taxonomy — raw provider bodies are never forwarded.
 * The counter store is the in-memory Meter (src/core/ai/meter.ts): there is no
 * storage binding, which is the plan's no-storage property rather than an
 * omission. A cold isolate starts its counters at zero.
 */
import type { Meter } from '../core/ai/meter'
import type { MuseProvider } from '../core/ai/provider'
import type { ProxyError } from '../core/ai/proxy-errors'

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

/** Map a thrown provider failure onto the closed taxonomy. */
export function mapProviderError(e: unknown): ProxyReply {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'rate_limited') return err(429, 'rate_limited')
  if (code === 'credits_exhausted') return err(429, 'credits_exhausted')
  if (code === 'bad_key') return err(401, 'bad_key')
  return err(502, 'provider_down')
}
