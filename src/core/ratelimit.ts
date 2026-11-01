/**
 * Request pacing and quota management.
 *
 * Every data source here is a free public service, and the Census Bureau in
 * particular documents a 500-request-per-day ceiling per key. That budget is
 * shared by every visitor who happens to use the same key, so spending it
 * carelessly is not just rude, it is how a key gets throttled for everyone.
 *
 * Three mechanisms, deliberately conservative because the API publishes no
 * rate-limit headers to inform a client:
 *
 *   1. A concurrency cap, so 34 chunks never become 34 simultaneous requests.
 *      Concurrency, not total volume, is what provokes a 503 on a heavy
 *      800-row query.
 *   2. A minimum interval between requests, with jitter so many clients do not
 *      synchronise into a thundering herd.
 *   3. A daily request budget, counted per key, so exhaustion is reported
 *      before it is hit rather than after.
 *
 * Backoff is handled in `http.ts`; this file owns pacing and budget.
 */

const MIN_INTERVAL_MS = 400
const MAX_CONCURRENCY = 2
const DEFAULT_DAILY_BUDGET = 450

export interface RateLimitConfig {
  minIntervalMs: number
  maxConcurrency: number
  dailyBudget: number
}

let config: RateLimitConfig = {
  minIntervalMs: MIN_INTERVAL_MS,
  maxConcurrency: MAX_CONCURRENCY,
  dailyBudget: DEFAULT_DAILY_BUDGET,
}

export function configureRateLimit(next: Partial<RateLimitConfig>): void {
  config = { ...config, ...next }
}

export function getRateLimit(): RateLimitConfig {
  return { ...config }
}

// ---------------------------------------------------------------- budget

export interface BudgetState {
  /** Requests used in the current UTC day. */
  used: number
  /** UTC day stamp, e.g. "2026-09-29". */
  day: string
}

const BUDGET_KEY = 'civicscope.censusBudget.v1'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function readBudget(): BudgetState {
  try {
    const raw = localStorage.getItem(BUDGET_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as BudgetState
      if (parsed.day === today()) return { used: parsed.used ?? 0, day: parsed.day }
    }
  } catch {
    /* storage unavailable; fall through to a fresh budget */
  }
  return { used: 0, day: today() }
}

function writeBudget(state: BudgetState): void {
  try {
    localStorage.setItem(BUDGET_KEY, JSON.stringify(state))
  } catch {
    /* in-memory accounting still works for this session */
  }
}

let budget = readBudget()

export function budgetState(): { used: number; limit: number; remaining: number; day: string } {
  if (budget.day !== today()) budget = { used: 0, day: today() }
  return {
    used: budget.used,
    limit: config.dailyBudget,
    remaining: Math.max(0, config.dailyBudget - budget.used),
    day: budget.day,
  }
}

export function recordRequest(): void {
  if (budget.day !== today()) budget = { used: 0, day: today() }
  budget.used += 1
  writeBudget(budget)
}

/**
 * Requests held back from the country-wide sweep so a deep dive always works.
 *
 * The sweep is 43 requests against an allowance of 450, so it cannot actually
 * exhaust a day. The risk runs the other way and is less obvious: a reader who
 * opens a ZIP code, then browses ten more, has spent enough that the *next*
 * sweep — which is what makes their search meaningful — starts being refused
 * and the screen sits half-built.
 *
 * This is the floor the sweep stops at. A drilldown is not subject to it,
 * because the thing someone asked for in the last moment should not be the
 * thing that fails.
 */
const DRILLDOWN_RESERVE = 120

/** True when the remaining budget has fallen to the drilldown reserve. */
export function sweepBudgetExhausted(): boolean {
  return Math.max(0, getRateLimit().dailyBudget - budget.used) <= DRILLDOWN_RESERVE
}

export function resetBudget(): void {
  budget = { used: 0, day: today() }
  writeBudget(budget)
}

export class QuotaExhaustedError extends Error {
  constructor(public readonly state: ReturnType<typeof budgetState>) {
    super(
      `Daily request budget reached (${state.used} of ${state.limit}). ` +
        'Figures already fetched remain available from the local cache; new areas will load after the budget resets.',
    )
    this.name = 'QuotaExhaustedError'
  }
}

// ------------------------------------------------------------- scheduling

let active = 0
let lastStartedAt = 0
const queue: (() => void)[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Jitter avoids synchronising many clients onto the same instant. */
function jitter(base: number): number {
  return base * (0.75 + Math.random() * 0.5)
}

function pump(): void {
  if (active >= config.maxConcurrency) return
  const next = queue.shift()
  if (!next) return
  // The slot is reserved here, before the queued waiter resumes, so two waiters
  // cannot both observe a free slot and start together.
  active += 1
  next()
}

async function acquire(): Promise<void> {
  if (budgetState().remaining <= 0) throw new QuotaExhaustedError(budgetState())

  if (active < config.maxConcurrency) {
    active += 1
    // Enforce a minimum gap between starts, but do not serialise the body.
    const wait = jitter(config.minIntervalMs) - (Date.now() - lastStartedAt)
    if (wait > 0) await sleep(wait)
    lastStartedAt = Date.now()
    return
  }

  await new Promise<void>((resolve) => {
    queue.push(() => {
      void (async () => {
        const wait = jitter(config.minIntervalMs) - (Date.now() - lastStartedAt)
        if (wait > 0) await sleep(wait)
        lastStartedAt = Date.now()
        // The slot was already reserved by pump(), so it is not claimed again.
        resolve()
      })()
    })
    pump()
  })
}

function release(): void {
  active = Math.max(0, active - 1)
  pump()
}

/**
 * Runs a request under the pacing rules: concurrency-capped, spaced, and
 * counted against the daily budget.
 */
export async function paced<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    recordRequest()
    return await fn()
  } finally {
    release()
  }
}

/** Test seam: clears in-flight state so tests do not leak across cases. */
export function _resetPacing(): void {
  active = 0
  lastStartedAt = 0
  queue.length = 0
  budget = { used: 0, day: today() }
}
