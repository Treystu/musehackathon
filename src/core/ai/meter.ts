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
 */

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

  settle(id: string, clientId: string, actualMicroUsd: number, tin: number, tout: number): void {
    this.reservations.delete(id)
    this.countCall(clientId, actualMicroUsd, tin, tout)
  }

  /**
   * Count one completed provider call, with no reservation and no
   * admission check of any kind: this is the only counting entry
   * point the request path uses (accounting-only meter, 2026-11-02).
   * The success bookkeeping settle() always did still applies — a
   * provider that just answered is healthy, so the consecutive
   * failure count resets and a half-open breaker closes.
   */
  recordCall(clientId: string, actualMicroUsd: number, tin: number, tout: number): void {
    this.countCall(clientId, actualMicroUsd, tin, tout)
  }

  private countCall(clientId: string, actualMicroUsd: number, tin: number, tout: number): void {
    this.requests += 1
    this.tokensIn += tin
    this.tokensOut += tout
    this.spentMicroUsd += actualMicroUsd
    this.perClientSpent.set(clientId, (this.perClientSpent.get(clientId) ?? 0) + actualMicroUsd)
    this.failures = 0
    if (this.breaker === 'half-open') this.breaker = 'closed'
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
