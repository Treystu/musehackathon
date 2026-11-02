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
  /** Wait-out timing; tests inject ~0. Defaults to DEFAULT_WAIT_OUT. */
  waitOut?: WaitOutConfig
}

/**
 * Wait-out timing for the flap windows the upstream was measured in
 * (2026-11-01: minute-scale windows in which identical requests
 * alternated between clean answers and failures, and the owner's own
 * questions never completed). Simplified after two Jev
 * needs_improvement rounds on heavier designs (attempt tagging,
 * ~5-minute stacked waits): the gate waits out one breaker cooldown,
 * the provider call retries twice inside the route, and the shipped
 * client retry remains the outer layer — combined coverage of roughly
 * two minutes, with longer outages ending in the honest paused copy.
 * Breaker accounting is unchanged: one recordFailure per route
 * request, from the final attempt only.
 */
export interface WaitOutConfig {
  breakerWaitMs: number
  pollMs: number
  retryDelaysMs: readonly number[]
}

export const DEFAULT_WAIT_OUT: WaitOutConfig = {
  breakerWaitMs: 40_000,
  pollMs: 2_000,
  retryDelaysMs: [8_000, 20_000],
}

export function waitOutFor(deps: ProxyDeps): WaitOutConfig {
  return deps.waitOut ?? DEFAULT_WAIT_OUT
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll the breaker until it is no longer open or the wait budget is
 * spent. A meter that throws fails the wait immediately (the caller's
 * fail-closed mapping handles it) — waiting never swallows a meter
 * outage into an unmetered call.
 */
export async function waitForBreaker(deps: ProxyDeps): Promise<boolean> {
  const cfg = waitOutFor(deps)
  const deadline = Date.now() + cfg.breakerWaitMs
  for (;;) {
    if ((await deps.meter.breakerState()) !== 'open') return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(cfg.pollMs, Math.max(0, deadline - Date.now())))
  }
}

/**
 * Run a provider call with the route's retry schedule. Only the two
 * flap classes retry — provider_down and bad_key, the same classes
 * the provider's own completion retry uses; rate limits and billing
 * failures will not heal inside one request, and validation verdicts
 * are values, not throws. Real provider failures always carry one of
 * the closed codes by the time they reach a route. The final throw
 * propagates to the handler's catch, which records the request's one
 * breaker failure.
 */
const RETRYABLE_PROVIDER_CODES: ReadonlySet<string> = new Set(['provider_down', 'bad_key'])

export async function attemptCall<T>(deps: ProxyDeps, call: () => Promise<T>): Promise<T> {
  const delays = waitOutFor(deps).retryDelaysMs
  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await call()
    } catch (e) {
      lastErr = e
      const code = (e as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || !RETRYABLE_PROVIDER_CODES.has(code)) throw e
      if (attempt < delays.length) await sleep(delays[attempt]!)
    }
  }
  throw lastErr
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
  // An open breaker is waited out, not failed on sight (see
  // DEFAULT_WAIT_OUT): the pause lasts ~30 s by configuration, and a
  // reader whose question lands inside it should get the answer when
  // it lifts. No reservation is held during the wait — reserve happens
  // in the handlers, after this gate passes.
  if ((await deps.meter.breakerState()) === 'open' && !(await waitForBreaker(deps))) {
    return err(503, 'breaker_open')
  }
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
