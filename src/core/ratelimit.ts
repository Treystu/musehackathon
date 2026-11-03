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
 *   3. A daily request budget, counted per browser, so usage is reported
 *      truthfully and a runaway loop has a backstop.
 *
 * Backoff is handled in `http.ts`; this file owns pacing and budget.
 */

const MIN_INTERVAL_MS = 400
const MAX_CONCURRENCY = 2
/**
 * The per-browser daily allowance (Lane completion K10, owner
 * directive 2026-11-03: "Increase it, so judges can't hit any
 * caps"). This was 450, set just under the Bureau's published
 * 500/day per-key ceiling — and on 2026-11-03 a single morning of
 * verification runs in one browser profile spent all 450 and the
 * exhaustion state then failed country-wide loads and an answer's
 * map in that profile. The measured shape of real use: a heavy
 * state-wide research run costs ~60 counted requests, a
 * country-wide sweep 43. At 100,000, a single session would need
 * well over a thousand heavy runs in one UTC day to reach the
 * wall — unreachable by construction, which is the point.
 *
 * What the mechanism retains: the counter still counts every
 * counted request and budgetState() still reports used/limit/
 * remaining truthfully; the drilldown-reserve arithmetic below
 * stays coherent against this figure (the sweep checks the same
 * remaining count it always did); the concurrency cap and minimum
 * interval — the mechanisms that actually protect the key from
 * stampedes — are untouched. What it no longer pretends to do:
 * bound the aggregate draw on a shared key across many parallel
 * browsers. A per-browser counter never could (the residual is
 * recorded in the completion program's RESULTS.md); the shipped
 * mitigation for the aggregate is per-session draw reduction —
 * cache-first fetches (a cache hit spends nothing), baked data
 * where it exists, and keyless paths riding the keyless posture.
 * The observed evidence for the Bureau's side: on 2026-11-03
 * multiple verification profiles each consumed hundreds of Census
 * requests in one day, with zero Census refusals observed.
 */
const DEFAULT_DAILY_BUDGET = 100_000

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
 * The sweep is 43 requests against an allowance of 100,000 (see
 * DEFAULT_DAILY_BUDGET), so it cannot plausibly exhaust a day. The
 * risk this floor guards is the less obvious one: a reader who opens
 * a ZIP code, then browses ten more, has spent enough that the *next*
 * sweep — which is what makes their search meaningful — starts being
 * refused and the screen sits half-built. The arithmetic is
 * unchanged since the allowance was 450: the sweep stops when the
 * remaining count falls to this floor, a state the new allowance
 * puts beyond any real session's reach.
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

async function acquire(checkBudget: boolean): Promise<void> {
  if (checkBudget && budgetState().remaining <= 0) throw new QuotaExhaustedError(budgetState())

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
 *
 * The budget posture is explicit (Lane completion K2, 2026-11-03):
 * the daily budget exists to protect the Census API KEY — the
 * Bureau's 500/day ceiling is per key, and only requests that spend
 * the key can threaten it. A keyless request (the result map's
 * TIGERweb geometry is the shipped case: keyless, cached for 90
 * days, and the only fetch standing between a carded answer and its
 * map) must therefore neither be WALLED by the key's budget nor
 * COUNTED against it. Before this posture existed, geometry rode
 * the counted default: an exhausted budget failed the map of an
 * answer whose figures were already in hand (production specimen,
 * 2026-11-03), and every geometry fetch drained the key budget it
 * never spent. `{ budget: 'keyless' }` keeps the queue's
 * concurrency cap and minimum interval — the stampede discipline —
 * and skips only the key-budget throw and count. The default stays
 * 'counted': every keyed caller is unchanged by construction.
 */
export async function paced<T>(
  fn: () => Promise<T>,
  opts: { budget?: 'counted' | 'keyless' } = {},
): Promise<T> {
  const counted = opts.budget !== 'keyless'
  await acquire(counted)
  try {
    if (counted) recordRequest()
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
