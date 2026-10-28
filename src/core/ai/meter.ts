/**
 * Q1 aggregate meter: counts only, never content. Reservation/settlement,
 * circuit breaker, per-client cap support (cap values are config, set at S10).
 */

export interface MeterConfig {
  /** Hard shutoff ceiling in micro-dollars (integer money; no floats). */
  budgetCapMicroUsd: number
  /** Per-client cap in micro-dollars; undefined = not yet configured (S10). */
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

type BreakerState = 'closed' | 'open' | 'half-open'

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
