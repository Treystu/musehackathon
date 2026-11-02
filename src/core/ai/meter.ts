/**
 * Q1 aggregate meter: counts only, never content.
 *
 * Accounting only (owner directive, 2026-11-02): the meter counts and
 * reports, but it is not an admission gate. The request path records
 * completed calls with recordCall(); the budget and per-client caps
 * are reporting thresholds — snapshot() still reports budgetExhausted
 * so diagnostics stays truthful — and no route refuses or pauses a
 * request because of them. The circuit breaker below is the provider
 * breaker: it tracks genuine upstream failures (recordFailure) and a
 * successful call resets it; it is provider health, not budget.
 *
 * reserve/settle/release remain on this class because the persisted
 * meter's stored record and the Durable Object op surface carry them;
 * no route calls them any more.
 *
 * P7 (2026-11-02): alongside the flat totals, the meter records the
 * usage splits (usage.ts) -- tokens and call counts by model and by
 * route, completed web-search counts, and the hourglass bookend
 * outcomes mirrored from bookend-counters.ts. The splits live here,
 * in the same store as the totals, so the durable deployment keeps
 * one global aggregate for them too; the in-isolate bookend counters
 * remain only as the fallback view for a deployment (or a read) with
 * no meter store behind it. snapshot() is unchanged on purpose: the
 * splits are a separate view (usageSnapshot), so every existing
 * snapshot consumer keeps its exact shape.
 */
import type { BookendCounters } from './bookend-counters'
import {
  sanitizeUsageModel,
  sanitizeUsageRoute,
  zeroHourglass,
  zeroUsageSnapshot,
  type UsageBucket,
  type UsageDetail,
  type UsageModel,
  type UsageRoute,
  type UsageSnapshot,
} from './usage'

export interface MeterConfig {
  /**
   * Budget reporting threshold in micro-dollars (integer money; no
   * floats). Diagnostics reports spend against it; since 2026-11-02
   * it refuses nothing.
   */
  budgetCapMicroUsd: number
  /**
   * Per-client cap in micro-dollars; undefined = not configured.
   * Reporting configuration only: the judged flow enforces no
   * per-client cap (owner resolution, 2026-11-02).
   */
  perClientCapMicroUsd?: number
  /** Per-request token ceiling. */
  perRequestTokenCeiling: number
  breakerFailureThreshold: number
  breakerCooldownMs: number
}

export interface MeterSnapshot {
  requests: number
  tokensIn: number
  tokensOut: number
  spentMicroUsd: number
  budgetExhausted: boolean
  errors: Record<string, number>
}

export type BreakerState = 'closed' | 'open' | 'half-open'

function bumpBucket(
  map: Map<string, UsageBucket>,
  key: UsageModel | UsageRoute,
  tin: number,
  tout: number,
): void {
  const bucket = map.get(key) ?? { calls: 0, tokensIn: 0, tokensOut: 0 }
  bucket.calls += 1
  bucket.tokensIn += tin
  bucket.tokensOut += tout
  map.set(key, bucket)
}

function cloneBuckets(map: Map<string, UsageBucket>): Record<string, UsageBucket> {
  return Object.fromEntries([...map].map(([k, v]) => [k, { ...v }]))
}

/**
 * Full internal state of a Meter (counts only, Q1), exported/imported by
 * the persistence adapter (meter-persistence.ts). Mirrors the private
 * fields field-for-field; reservations carry no expiry here — the TTL
 * lives in the persisted record owned by the adapter.
 * (Union hand-merge: this interface and the exportState/importState
 * methods below come from the Entire tree's meter; the rest of this file
 * is the CivicScope version, including configSnapshot for diagnostics.)
 */
export interface MeterState {
  requests: number
  tokensIn: number
  tokensOut: number
  spentMicroUsd: number
  failures: number
  breaker: BreakerState
  breakerOpenedAt: number
  errors: Record<string, number>
  perClientSpent: Record<string, number>
  reservations: Record<string, { clientId: string; estMicroUsd: number }>
  nextReservationId: number
  /** P7 splits (usage.ts). Keyed by the closed model/route unions. */
  usageByModel: Record<string, UsageBucket>
  usageByRoute: Record<string, UsageBucket>
  searches: number
  hourglass: BookendCounters
}

export class Meter {
  private requests = 0
  private tokensIn = 0
  private tokensOut = 0
  private spentMicroUsd = 0
  private failures = 0
  private breaker: BreakerState = 'closed'
  private breakerOpenedAt = 0
  private readonly errors = new Map()
  private readonly perClientSpent = new Map<string, number>()
  private readonly reservations = new Map<
    string,
    { clientId: string; estMicroUsd: number }
  >()
  private nextReservationId = 0
  private readonly usageByModel = new Map<string, UsageBucket>()
  private readonly usageByRoute = new Map<string, UsageBucket>()
  private searches = 0
  private hourglass: BookendCounters = zeroHourglass()

  constructor(private readonly cfg: MeterConfig) {}

  snapshot(): MeterSnapshot {
    return {
      requests: this.requests,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      spentMicroUsd: this.spentMicroUsd,
      budgetExhausted: this.spentMicroUsd >= this.cfg.budgetCapMicroUsd,
      errors: Object.fromEntries(this.errors),
    }
  }

  /**
   * Configuration the diagnostics surface may report. The per-client cap is
   * deliberately a boolean: S10 is the owner's number, and an operator
   * endpoint does not need to publish it to prove whether one is configured.
   */
  configSnapshot(): {
    budgetCapMicroUsd: number
    perClientCapConfigured: boolean
    perRequestTokenCeiling: number
    breakerFailureThreshold: number
    breakerCooldownMs: number
  } {
    return {
      budgetCapMicroUsd: this.cfg.budgetCapMicroUsd,
      perClientCapConfigured: this.cfg.perClientCapMicroUsd !== undefined,
      perRequestTokenCeiling: this.cfg.perRequestTokenCeiling,
      breakerFailureThreshold: this.cfg.breakerFailureThreshold,
      breakerCooldownMs: this.cfg.breakerCooldownMs,
    }
  }

  breakerState(now = Date.now()): BreakerState {
    if (this.breaker === 'open' && now - this.breakerOpenedAt >= this.cfg.breakerCooldownMs) {
      this.breaker = 'half-open'
    }
    return this.breaker
  }

  /** Reserve budget before a provider call. Returns reservation id or null. */
  reserve(clientId: string, estMicroUsd: number, estTokens: number): string | null {
    if (this.breakerState() === 'open') return null
    if (!Number.isFinite(estMicroUsd) || estMicroUsd <= 0) return null
    if (!Number.isFinite(estTokens) || estTokens <= 0) return null
    if (estTokens > this.cfg.perRequestTokenCeiling) return null

    const outstanding = [...this.reservations.values()].reduce(
      (sum, r) => sum + r.estMicroUsd,
      0,
    )
    if (this.spentMicroUsd + outstanding + estMicroUsd > this.cfg.budgetCapMicroUsd) {
      return null
    }

    if (this.cfg.perClientCapMicroUsd !== undefined) {
      const used = this.perClientSpent.get(clientId) ?? 0
      const clientOutstanding = [...this.reservations.values()]
        .filter((r) => r.clientId === clientId)
        .reduce((sum, r) => sum + r.estMicroUsd, 0)
      if (used + clientOutstanding + estMicroUsd > this.cfg.perClientCapMicroUsd) {
        return null
      }
    }

    // Monotonic ids never reuse a live reservation's id, even after release.
    const id = `r${++this.nextReservationId}`
    this.reservations.set(id, { clientId, estMicroUsd })
    return id
  }

  settle(
    id: string,
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): void {
    this.reservations.delete(id)
    this.countCall(clientId, actualMicroUsd, tin, tout, detail)
  }

  /**
   * Count one completed provider call, with no reservation and no
   * admission check of any kind: this is the only counting entry
   * point the request path uses (accounting-only meter, 2026-11-02).
   * The success bookkeeping settle() always did still applies — a
   * provider that just answered is healthy, so the consecutive
   * failure count resets and a half-open breaker closes.
   */
  recordCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): void {
    this.countCall(clientId, actualMicroUsd, tin, tout, detail)
  }

  private countCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): void {
    this.requests += 1
    this.tokensIn += tin
    this.tokensOut += tout
    this.spentMicroUsd += actualMicroUsd
    this.perClientSpent.set(clientId, (this.perClientSpent.get(clientId) ?? 0) + actualMicroUsd)
    this.failures = 0
    if (this.breaker === 'half-open') this.breaker = 'closed'
    // P7 splits: the same call, bucketed by the closed model/route
    // unions. An unlisted model or route is dropped from the splits
    // only -- the global totals above always count the call.
    const model = sanitizeUsageModel(detail?.model)
    if (model) bumpBucket(this.usageByModel, model, tin, tout)
    const route = sanitizeUsageRoute(detail?.route)
    if (route) bumpBucket(this.usageByRoute, route, tin, tout)
  }

  /**
   * Count completed web_search calls from one research reply (P7).
   * Search bills separately from tokens ($2.50 per 1,000), so it is
   * its own counter, never folded into a token bucket. A count that
   * is not a positive integer is ignored rather than estimated.
   */
  recordSearches(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.searches += Math.trunc(count)
  }

  /** Mirror one top-bookend outcome into the durable store (P7). */
  recordTopBookend(outcome: keyof BookendCounters['top']): void {
    if (outcome === 'sound' || outcome === 'unsound' || outcome === 'degraded') {
      this.hourglass.top[outcome] += 1
    }
  }

  /** Mirror one bottom-bookend outcome into the durable store (P7). */
  recordBottomBookend(outcome: keyof BookendCounters['bottom']): void {
    if (outcome === 'verified' || outcome === 'concerns' || outcome === 'notRun') {
      this.hourglass.bottom[outcome] += 1
    }
  }

  /**
   * The P7 split view: every closed key present, zero-filled, deep
   * copied -- diagnostics renders this shape verbatim after its own
   * sanitize pass, so the shape is stable whether or not any call
   * has been recorded under a given key.
   */
  usageSnapshot(): UsageSnapshot {
    const out = zeroUsageSnapshot()
    for (const [model, bucket] of this.usageByModel) {
      const key = sanitizeUsageModel(model)
      if (key) out.byModel[key] = { ...bucket }
    }
    for (const [route, bucket] of this.usageByRoute) {
      const key = sanitizeUsageRoute(route)
      if (key) out.byRoute[key] = { ...bucket }
    }
    out.searches = this.searches
    out.hourglass = {
      top: { ...this.hourglass.top },
      bottom: { ...this.hourglass.bottom },
    }
    return out
  }

  release(id: string): void {
    this.reservations.delete(id)
  }

  /** Count one failure by closed error class (counts only, Q1). */
  recordError(cls: string): void {
    this.errors.set(cls, (this.errors.get(cls) ?? 0) + 1)
  }
  recordFailure(now = Date.now()): void {
    this.failures += 1
    if (this.failures >= this.cfg.breakerFailureThreshold) {
      this.breaker = 'open'
      this.breakerOpenedAt = now
    }
  }

  /** Export the full state (deep copy) for a persistence adapter. */
  exportState(): MeterState {
    return {
      requests: this.requests,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      spentMicroUsd: this.spentMicroUsd,
      failures: this.failures,
      breaker: this.breaker,
      breakerOpenedAt: this.breakerOpenedAt,
      errors: Object.fromEntries(this.errors),
      perClientSpent: Object.fromEntries(this.perClientSpent),
      reservations: Object.fromEntries(
        [...this.reservations].map(([id, r]) => [id, { ...r }]),
      ),
      nextReservationId: this.nextReservationId,
      usageByModel: cloneBuckets(this.usageByModel),
      usageByRoute: cloneBuckets(this.usageByRoute),
      searches: this.searches,
      hourglass: {
        top: { ...this.hourglass.top },
        bottom: { ...this.hourglass.bottom },
      },
    }
  }

  /** Replace the full state with a previously exported one (deep copy). */
  importState(state: MeterState): void {
    this.requests = state.requests
    this.tokensIn = state.tokensIn
    this.tokensOut = state.tokensOut
    this.spentMicroUsd = state.spentMicroUsd
    this.failures = state.failures
    this.breaker = state.breaker
    this.breakerOpenedAt = state.breakerOpenedAt
    this.errors.clear()
    for (const [k, v] of Object.entries(state.errors)) this.errors.set(k, v)
    this.perClientSpent.clear()
    for (const [k, v] of Object.entries(state.perClientSpent)) {
      this.perClientSpent.set(k, v)
    }
    this.reservations.clear()
    for (const [k, v] of Object.entries(state.reservations)) {
      this.reservations.set(k, { ...v })
    }
    this.nextReservationId = state.nextReservationId
    // P7 fields tolerate absence: a state exported by pre-P7 code (or
    // a hand-built fixture) imports as zero splits, not a crash.
    this.usageByModel.clear()
    for (const [k, v] of Object.entries(state.usageByModel ?? {})) {
      if (sanitizeUsageModel(k)) this.usageByModel.set(k, { ...v })
    }
    this.usageByRoute.clear()
    for (const [k, v] of Object.entries(state.usageByRoute ?? {})) {
      if (sanitizeUsageRoute(k)) this.usageByRoute.set(k, { ...v })
    }
    this.searches = state.searches ?? 0
    const hg = state.hourglass
    this.hourglass = hg
      ? { top: { ...hg.top }, bottom: { ...hg.bottom } }
      : zeroHourglass()
  }
}

/** Judging-window cap from plan §6.4: $52.50 = 52_500_000 micro-USD. */
export const JUDGING_CAP_MICRO_USD = 52_500_000

export function defaultMeterConfig(): MeterConfig {
  return {
    budgetCapMicroUsd: JUDGING_CAP_MICRO_USD,
    perRequestTokenCeiling: 4096,
    breakerFailureThreshold: 5,
    breakerCooldownMs: 30_000,
  }
}
