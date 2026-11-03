/**
 * Per-model / per-route usage splits and true-cost pricing (P7,
 * 2026-11-02). The flat meter totals (meter.ts) answer "how much did
 * the modelled accounting record"; this module answers the different
 * question the owner asked for: "what did the tokens and searches
 * actually cost, split by the model and the stage that spent them".
 * The two numbers tell different stories by design -- the flat settle
 * constants are per-route bookkeeping (intent settles 1,000 micro-USD
 * whatever the reply cost), while the true cost below prices the
 * recorded token counts at roster rates. Diagnostics reports both,
 * each labelled; neither replaces the other.
 *
 * Closed vocabularies, like every other diagnostics surface: a model
 * or route outside the lists below is dropped from the splits (its
 * tokens still land in the global totals), so a provider-reported
 * string can never become a diagnostics key.
 *
 * Pricing provenance, stated plainly because the tree does not carry
 * it: a full-tree search on 2026-11-02 found NO roster token price in
 * this repository -- docs/full-muse-layer-plan.md (sections 6.4 and
 * the S2 note) deliberately does not invent a rate and defers to the
 * live Meta pricing page. The figures below are therefore the rates
 * supplied with the P7 build brief (owner framing, 2026-11-02):
 * Spark $1.25 in / $4.25 out per 1M tokens, Wonder $4 in / $20 out
 * per 1M, web search $2.50 per 1,000 searches. They live in exactly
 * one place (this file) so a corrected rate is a one-line change.
 *
 * Accounting only, unchanged: everything here is computed on the
 * diagnostics read path from already-recorded counters. Nothing in
 * this module is consulted by a request path, so it cannot gate,
 * delay, or fail a request.
 */
import type {
  BookendCounters,
  BookendLastSettleMap,
  BookendSettleClass,
} from './bookend-counters'
import { MUSE_SPARK_MODEL, MUSE_WONDER_MODEL } from './meta-client'

export const USAGE_MODELS = [MUSE_SPARK_MODEL, MUSE_WONDER_MODEL] as const
export type UsageModel = (typeof USAGE_MODELS)[number]

/**
 * The instrumented stages. Briefing and transcribe still settle into
 * the global totals at their flat constants, but they carry no split:
 * briefing was not in the P7 route list, and transcribe runs the ASR
 * model, which has no roster token price to split against. The Jev
 * route records no meter settle at all (TypeSafe-side spend; see
 * functions/api/muse/jev.ts), so it appears in neither split.
 */
export const USAGE_ROUTES = ['intent', 'explain', 'research', 'plan', 'verify'] as const
export type UsageRoute = (typeof USAGE_ROUTES)[number]

export interface UsageBucket {
  calls: number
  tokensIn: number
  tokensOut: number
}

/** The split view of the meter: counts only, keyed by closed unions. */
export interface UsageSnapshot {
  byModel: Record<UsageModel, UsageBucket>
  byRoute: Record<UsageRoute, UsageBucket>
  /** Completed web_search calls counted in the research path. */
  searches: number
  /**
   * Hourglass bookend outcomes, mirrored into the durable meter by
   * the plan/verify routes (P7 cure for the in-isolate counters in
   * bookend-counters.ts, which reset on every cold isolate and so
   * undercount across isolates).
   */
  hourglass: BookendCounters
  /**
   * The latest bookend settle per side, mirrored durably with the
   * counts (Item 2 cure, 2026-11-03): diagnostics reads this copy
   * when the meter view is readable, so last-settle attribution
   * survives isolate churn the way the counts already did.
   */
  hourglassLastSettle: BookendLastSettleMap
}

/** Optional split detail a route attaches to its settle. */
export interface UsageDetail {
  model?: string
  route?: string
}

export function sanitizeUsageModel(value: unknown): UsageModel | undefined {
  return typeof value === 'string' && (USAGE_MODELS as readonly string[]).includes(value)
    ? (value as UsageModel)
    : undefined
}

export function sanitizeUsageRoute(value: unknown): UsageRoute | undefined {
  return typeof value === 'string' && (USAGE_ROUTES as readonly string[]).includes(value)
    ? (value as UsageRoute)
    : undefined
}

/** Roster token prices, micro-USD per 1,000,000 tokens. See header. */
export const TOKEN_PRICE_MICRO_USD_PER_MILLION: Record<
  UsageModel,
  { input: number; output: number }
> = {
  [MUSE_SPARK_MODEL]: { input: 1_250_000, output: 4_250_000 },
  [MUSE_WONDER_MODEL]: { input: 4_000_000, output: 20_000_000 },
}

/** Web search billing: $2.50 per 1,000 searches = 2,500 micro-USD each. */
export const SEARCH_COST_MICRO_USD_PER_SEARCH = 2_500

function zeroBucket(): UsageBucket {
  return { calls: 0, tokensIn: 0, tokensOut: 0 }
}

export function zeroHourglass(): BookendCounters {
  return {
    top: { sound: 0, unsound: 0, degraded: 0 },
    bottom: { verified: 0, concerns: 0, notRun: 0 },
  }
}

export function zeroHourglassLastSettle(): BookendLastSettleMap {
  return { top: null, bottom: null }
}

export function zeroUsageSnapshot(): UsageSnapshot {
  return {
    byModel: {
      [MUSE_SPARK_MODEL]: zeroBucket(),
      [MUSE_WONDER_MODEL]: zeroBucket(),
    },
    byRoute: {
      intent: zeroBucket(),
      explain: zeroBucket(),
      research: zeroBucket(),
      plan: zeroBucket(),
      verify: zeroBucket(),
    },
    searches: 0,
    hourglass: zeroHourglass(),
    hourglassLastSettle: zeroHourglassLastSettle(),
  }
}

/** Non-negative finite count, truncated; anything else reads as zero. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

function sanitizeBucket(raw: unknown): UsageBucket {
  const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    calls: toCount(rec.calls),
    tokensIn: toCount(rec.tokensIn),
    tokensOut: toCount(rec.tokensOut),
  }
}

function sanitizeHourglass(raw: unknown): BookendCounters {
  const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const top = (typeof rec.top === 'object' && rec.top !== null ? rec.top : {}) as Record<string, unknown>
  const bottom = (typeof rec.bottom === 'object' && rec.bottom !== null ? rec.bottom : {}) as Record<string, unknown>
  return {
    top: {
      sound: toCount(top.sound),
      unsound: toCount(top.unsound),
      degraded: toCount(top.degraded),
    },
    bottom: {
      verified: toCount(bottom.verified),
      concerns: toCount(bottom.concerns),
      notRun: toCount(bottom.notRun),
    },
  }
}

const BOOKEND_SETTLE_CLASSES: readonly BookendSettleClass[] = [
  'settled-ok',
  'settled-error',
  'skipped',
]
const TOP_BOOKEND_OUTCOMES: readonly (keyof BookendCounters['top'])[] = [
  'sound',
  'unsound',
  'degraded',
]
const BOTTOM_BOOKEND_OUTCOMES: readonly (keyof BookendCounters['bottom'])[] = [
  'verified',
  'concerns',
  'notRun',
]

function sanitizeLastSettleSide<O extends string>(
  raw: unknown,
  outcomes: readonly O[],
): { at: string; outcome: O; settle: BookendSettleClass } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.at !== 'string') return null
  if (
    typeof rec.outcome !== 'string' ||
    !(outcomes as readonly string[]).includes(rec.outcome)
  ) {
    return null
  }
  if (
    typeof rec.settle !== 'string' ||
    !(BOOKEND_SETTLE_CLASSES as readonly string[]).includes(rec.settle)
  ) {
    return null
  }
  return {
    at: rec.at,
    outcome: rec.outcome as O,
    settle: rec.settle as BookendSettleClass,
  }
}

/**
 * Rebuild the durable last-settle record from known values only:
 * a side survives only when its timestamp is a string, its outcome
 * belongs to that side's closed outcome set, and its settle class
 * is one of the three classes. Anything else reads as null for
 * that side -- a malformed settle is absence, never a fabricated
 * attribution.
 */
export function sanitizeHourglassLastSettle(raw: unknown): BookendLastSettleMap {
  const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    top: sanitizeLastSettleSide(rec.top, TOP_BOOKEND_OUTCOMES) as BookendLastSettleMap['top'],
    bottom: sanitizeLastSettleSide(
      rec.bottom,
      BOTTOM_BOOKEND_OUTCOMES,
    ) as BookendLastSettleMap['bottom'],
  }
}

/**
 * Rebuild a usage snapshot from known keys only -- the same allowlist
 * discipline as the diagnostics export: unknown model/route keys in a
 * stored or transported record are dropped, never passed through.
 */
export function sanitizeUsageSnapshot(raw: unknown): UsageSnapshot {
  const out = zeroUsageSnapshot()
  if (typeof raw !== 'object' || raw === null) return out
  const rec = raw as Record<string, unknown>
  const byModel = (typeof rec.byModel === 'object' && rec.byModel !== null ? rec.byModel : {}) as Record<string, unknown>
  const byRoute = (typeof rec.byRoute === 'object' && rec.byRoute !== null ? rec.byRoute : {}) as Record<string, unknown>
  for (const model of USAGE_MODELS) out.byModel[model] = sanitizeBucket(byModel[model])
  for (const route of USAGE_ROUTES) out.byRoute[route] = sanitizeBucket(byRoute[route])
  out.searches = toCount(rec.searches)
  out.hourglass = sanitizeHourglass(rec.hourglass)
  out.hourglassLastSettle = sanitizeHourglassLastSettle(rec.hourglassLastSettle)
  return out
}

export interface TrueCosts {
  /** Token cost at roster prices, summed over the per-model splits. */
  tokenCostMicroUsd: number
  /** Web-search cost at SEARCH_COST_MICRO_USD_PER_SEARCH. */
  searchCostMicroUsd: number
  /** tokenCostMicroUsd + searchCostMicroUsd. */
  trueCostMicroUsd: number
  byModelCostMicroUsd: Record<UsageModel, number>
}

/** True cost of one bucket at a model's roster prices, micro-USD. */
export function bucketCostMicroUsd(model: UsageModel, bucket: UsageBucket): number {
  const price = TOKEN_PRICE_MICRO_USD_PER_MILLION[model]
  // Prices are per million tokens, so the product is exact integer
  // arithmetic until the single division; rounding to the nearest
  // micro-USD happens once, here, per model.
  return Math.round(
    (bucket.tokensIn * price.input + bucket.tokensOut * price.output) / 1_000_000,
  )
}

/**
 * Reconcile a usage snapshot into true costs. Only split tokens are
 * priced: tokens from routes with no split (briefing, transcribe)
 * sit in the global totals but in no model bucket, so this figure is
 * a floor for token cost, stated as such wherever it is reported.
 */
export function computeTrueCosts(usage: UsageSnapshot): TrueCosts {
  const byModelCostMicroUsd = {
    [MUSE_SPARK_MODEL]: bucketCostMicroUsd(MUSE_SPARK_MODEL, usage.byModel[MUSE_SPARK_MODEL]),
    [MUSE_WONDER_MODEL]: bucketCostMicroUsd(MUSE_WONDER_MODEL, usage.byModel[MUSE_WONDER_MODEL]),
  } as Record<UsageModel, number>
  const tokenCostMicroUsd =
    byModelCostMicroUsd[MUSE_SPARK_MODEL] + byModelCostMicroUsd[MUSE_WONDER_MODEL]
  const searchCostMicroUsd = usage.searches * SEARCH_COST_MICRO_USD_PER_SEARCH
  return {
    tokenCostMicroUsd,
    searchCostMicroUsd,
    trueCostMicroUsd: tokenCostMicroUsd + searchCostMicroUsd,
    byModelCostMicroUsd,
  }
}
