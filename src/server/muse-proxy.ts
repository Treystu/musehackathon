/**
 * Shared proxy machinery for /api/muse/* (House).
 * Closed error taxonomy — raw provider bodies are never forwarded.
 *
 * The meter is ACCOUNTING ONLY (owner directive, 2026-11-02): it
 * counts and reports, but it never blocks, gates, delays, or fails a
 * user request. Admission to a route is shape + allowlist + provider
 * health alone. The counter store behind ProxyDeps is the
 * MeterContract below: the in-isolate Meter (src/core/ai/meter.ts)
 * where no storage binding is configured, or the Durable Object
 * client (functions/api/muse/meter-do.ts) where the deployment binds
 * one — src/server/muse-adapter chooses, and the diagnostics route
 * reports which one a deployment actually carries.
 *
 * Why this changed, measured rather than believed: admission used to
 * run through the meter — a reserve before every provider call, and
 * budget/cap/breaker checks on the meter's snapshot — so one failed
 * Durable Object hop mapped to a fail-closed 503 breaker_open that
 * recorded nothing. Six hosted-browser sessions showed Explain and
 * Briefing "unavailable" in the UI while the same routes answered 200
 * to direct probes in the same windows; that fail-closed hop is the
 * standing suspect, and de-gating removes the class, not the symptom.
 * Caps are reporting thresholds only (diagnostics still reports
 * budgetCapMicroUsd / spent / budgetExhausted truthfully), and the
 * judged flow enforces no per-client cap. The provider breaker and
 * its wait-out STAY: they track genuine upstream failures, which is
 * provider health, not metering.
 */
import type {
  BreakerState,
  Meter,
  MeterSnapshot,
} from '../core/ai/meter'
import type { BookendCounters } from '../core/ai/bookend-counters'
import type { MuseProvider, StageChatProvider } from '../core/ai/provider'
import type { ProxyError } from '../core/ai/proxy-errors'
import type { UsageDetail, UsageSnapshot } from '../core/ai/usage'

/**
 * The meter surface the handlers account against. Each op may answer
 * synchronously (the in-isolate Meter) or across the Durable Object
 * hop (DurableMeterClient); the return unions let one deps shape
 * carry either, and `await` at the call sites normalises the two. The
 * synchronous Meter satisfies this contract structurally. There is
 * deliberately no reserve/settle/release here: counting a completed
 * call (recordCall) is the whole request-path surface.
 */
export interface MeterContract {
  recordCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): void | Promise<void>
  recordError(cls: string): void | Promise<void>
  recordFailure(now?: number): void | Promise<void>
  /** P7: count completed web_search calls from one research reply. */
  recordSearches(count: number): void | Promise<void>
  /** P7: mirror one hourglass bookend outcome into the meter store. */
  recordTopBookend(outcome: keyof BookendCounters['top']): void | Promise<void>
  recordBottomBookend(outcome: keyof BookendCounters['bottom']): void | Promise<void>
  snapshot(): MeterSnapshot | Promise<MeterSnapshot>
  /** P7 split view (usage.ts); diagnostics reads it on its read path. */
  usageSnapshot(): UsageSnapshot | Promise<UsageSnapshot>
  breakerState(now?: number): BreakerState | Promise<BreakerState>
  configSnapshot():
    | ReturnType<Meter['configSnapshot']>
    | Promise<ReturnType<Meter['configSnapshot']>>
}

export interface ProxyDeps {
  meter: MeterContract
  provider: MuseProvider
  /**
   * Stage-scoped completions with per-call model selection (C1).
   * Optional: a deployment without it serves the classic routes and
   * the bookend routes answer their typed degradation, because a
   * bookend that cannot call its stage model has not run.
   */
  stageProvider?: StageChatProvider
  /**
   * The deployment's configured runtime model (P7): the classic
   * routes (intent/explain/research) serve under this model, so
   * their settles are bucketed under it. Set by the adapter from the
   * same env value the provider is constructed with; absent in
   * hermetic deps, where routes fall back to the Spark default.
   * Accounting metadata only -- never an admission input.
   */
  model?: string
  allowedModels: readonly string[]
  /** Wait-out timing; tests inject ~0. Defaults to DEFAULT_WAIT_OUT. */
  waitOut?: WaitOutConfig
  /**
   * Deferral for best-effort accounting promises: the Pages adapter
   * wires the runtime's waitUntil here so a deferred Durable Object
   * accounting hop can finish after the reply is sent. Absent in
   * hermetic tests and non-Pages callers — accounting then runs
   * fire-and-forget on the same promise.
   */
  defer?: (promise: Promise<unknown>) => void
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
 * Breaker accounting is unchanged in count: one recordFailure per
 * route request, from the final attempt only — recorded best-effort,
 * like every meter write (see account() below).
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
 * Best-effort meter accounting: run one meter write so that its
 * failure is invisible to the request. The op starts immediately —
 * with the synchronous in-isolate Meter it has already landed when
 * this returns, which keeps hermetic route tests deterministic — and
 * any promise it returns is handed to deps.defer (the runtime's
 * waitUntil) when one is wired, or left fire-and-forget otherwise.
 * Sync throws and async rejections are swallowed alike: a lost
 * accounting record must never surface to a user, and diagnostics
 * keeps reporting truthfully for the calls that did record.
 */
export function account(deps: ProxyDeps, op: (meter: MeterContract) => void | Promise<void>): void {
  let result: void | Promise<void>
  try {
    result = op(deps.meter)
  } catch {
    return
  }
  if (result === undefined || result === null) return
  const safe = Promise.resolve(result).catch(() => undefined)
  if (deps.defer) {
    try {
      deps.defer(safe)
      return
    } catch {
      // A deferral hook that throws must not take the write's
      // invisibility down with it; fall through to fire-and-forget.
    }
  }
  void safe
}

/**
 * Count one completed provider call at its flat settle cost. The
 * optional P7 detail buckets the same call by model and route in
 * the meter's splits; omitting it (briefing, transcribe) counts the
 * call in the global totals only.
 */
export function accountCall(
  deps: ProxyDeps,
  clientId: string,
  actualMicroUsd: number,
  tin: number,
  tout: number,
  detail?: UsageDetail,
): void {
  account(deps, (meter) => meter.recordCall(clientId, actualMicroUsd, tin, tout, detail))
}

/** Count completed web_search calls from one research reply (P7). */
export function accountSearches(deps: ProxyDeps, count: number): void {
  account(deps, (meter) => meter.recordSearches(count))
}

/**
 * Mirror one hourglass bookend outcome into the meter store (P7),
 * alongside the in-isolate counter the routes have always recorded:
 * the meter copy is the durable, cross-isolate view diagnostics
 * reports; the in-isolate copy remains the fallback view.
 */
export function accountTopBookend(
  deps: ProxyDeps,
  outcome: keyof BookendCounters['top'],
): void {
  account(deps, (meter) => meter.recordTopBookend(outcome))
}

export function accountBottomBookend(
  deps: ProxyDeps,
  outcome: keyof BookendCounters['bottom'],
): void {
  account(deps, (meter) => meter.recordBottomBookend(outcome))
}

/** Count one failure by closed error class (counts only, Q1). */
export function accountError(deps: ProxyDeps, cls: string): void {
  account(deps, (meter) => meter.recordError(cls))
}

/** Record the request's one provider-breaker failure, best-effort. */
export function accountFailure(deps: ProxyDeps): void {
  account(deps, (meter) => meter.recordFailure())
}

/**
 * Read the provider breaker state for the gate. The breaker lives in
 * the meter store, so reading it can fail with the store — and a
 * store failure is an accounting outage, not a provider outage: it
 * answers 'closed' (proceed) here, never an admission refusal. Only
 * a state the store actually reported can wait a request out.
 */
async function breakerStateOrClosed(deps: ProxyDeps): Promise<BreakerState> {
  try {
    return await deps.meter.breakerState()
  } catch {
    return 'closed'
  }
}

/**
 * Poll the breaker until it is no longer open or the wait budget is
 * spent. An unreadable breaker reads as closed (see
 * breakerStateOrClosed), so the wait ends in "proceed", not a 503.
 */
export async function waitForBreaker(deps: ProxyDeps): Promise<boolean> {
  const cfg = waitOutFor(deps)
  const deadline = Date.now() + cfg.breakerWaitMs
  for (;;) {
    if ((await breakerStateOrClosed(deps)) !== 'open') return true
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

/**
 * Pre-call gates shared by every route: method/path allowlist, body
 * shape, model allowlist, and the provider breaker wait-out. Nothing
 * here reads a budget, a cap, or a reservation: spend state is
 * diagnostics data, not admission data (2026-11-02).
 */
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
  // An open provider breaker is waited out, not failed on sight (see
  // DEFAULT_WAIT_OUT): the pause lasts ~30 s by configuration, and a
  // reader whose question lands inside it should get the answer when
  // it lifts.
  if ((await breakerStateOrClosed(deps)) === 'open' && !(await waitForBreaker(deps))) {
    return err(503, 'breaker_open')
  }
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
