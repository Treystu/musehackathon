/**
 * Shared proxy machinery for /api/muse/* (House).
 * Closed error taxonomy — raw provider bodies are never forwarded.
 * The counter store behind ProxyDeps is the MeterContract below: the
 * in-isolate Meter (src/core/ai/meter.ts) where no storage binding is
 * configured, or the Durable Object client (functions/api/muse/
 * meter-do.ts) where the deployment binds one — src/server/muse-adapter
 * chooses, and the diagnostics route reports which one a deployment
 * actually carries. Handlers await every meter op, so the synchronous
 * and the network-backed meter are interchangeable here; a meter that
 * cannot be read or written fails closed (mapMeterError), never an
 * unmetered provider call.
 */
import type {
  BreakerState,
  Meter,
  MeterSnapshot,
} from '../core/ai/meter'
import { MeterUnavailableError } from '../core/ai/meter-persistence'
import type { MuseProvider } from '../core/ai/provider'
import type { ProxyError } from '../core/ai/proxy-errors'

/**
 * The meter surface the handlers settle against. Each op may answer
 * synchronously (the in-isolate Meter) or across the Durable Object hop
 * (DurableMeterClient); the return unions let one deps shape carry
 * either, and `await` at the call sites normalises the two. The
 * synchronous Meter satisfies this contract structurally.
 */
export interface MeterContract {
  reserve(
    clientId: string,
    estMicroUsd: number,
    estTokens: number,
  ): string | null | Promise<string | null>
  settle(
    id: string,
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
  ): void | Promise<void>
  release(id: string): void | Promise<void>
  recordError(cls: string): void | Promise<void>
  recordFailure(now?: number): void | Promise<void>
  snapshot(): MeterSnapshot | Promise<MeterSnapshot>
  breakerState(now?: number): BreakerState | Promise<BreakerState>
  configSnapshot():
    | ReturnType<Meter['configSnapshot']>
    | Promise<ReturnType<Meter['configSnapshot']>>
}

export interface ProxyDeps {
  meter: MeterContract
  provider: MuseProvider
  allowedModels: readonly string[]
}

export type ProxyReply = { status: number; body: Record<string, unknown> }

export function err(status: number, e: ProxyError, detail?: string): ProxyReply {
  return { status, body: detail ? { error: e, detail } : { error: e } }
}

/** Pre-call gates shared by every route: shutoff, breaker, model allowlist. */
export async function preCallGate(
  req: { method: string; body: unknown },
  deps: ProxyDeps,
  allowedPaths: ReadonlySet<string>,
  path: string,
): Promise<ProxyReply | null> {
  if (req.method !== 'POST' || !allowedPaths.has(path)) return err(400, 'not_allowlisted')
  const body = req.body as Record<string, unknown> | null
  if (typeof body !== 'object' || body === null) return err(400, 'shape_invalid')
  if (typeof body.model === 'string' && !deps.allowedModels.includes(body.model)) {
    return err(400, 'not_allowlisted')
  }
  if ((await deps.meter.snapshot()).budgetExhausted) return err(429, 'budget_exhausted')
  if ((await deps.meter.breakerState()) === 'open') return err(503, 'breaker_open')
  return null
}

/**
 * Map a meter persistence failure onto the closed taxonomy. A meter
 * that cannot be read or written fails closed as 503 breaker_open:
 * the AI surface degrades exactly as it does on an open breaker, and
 * no unmetered provider call is made. Anything else is provider_down.
 * (Mirror of functions/api/muse/shared.ts, kept beside the handlers'
 * shared machinery; the handlers import from here.)
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
