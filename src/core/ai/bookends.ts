/**
 * The Wonder bookends' client side (plan C2 top + C5 bottom): packet
 * builders with hard token budgets, the annex's exact verdict
 * schemas, and the labeling rule.
 *
 * The routes themselves are server work (a sibling lane); this module
 * consumes them through an injectable transport with the plan shapes,
 * so hermetic tests stub the transport and the runner's ordering +
 * labeling are pinned without a network.
 *
 * Labeling (plan C5, exact): the answer's verification record gains
 * `wonder: 'verified' | 'concerns' | 'not-run'`. User-visible copy
 * claims Wonder verification only when the field is 'verified' or
 * 'concerns' (with concerns shown). 'not-run' — timeout, error, no
 * endpoint, malformed verdict — shows nothing about Wonder. A
 * malformed verdict is a degradation, never a block (plan C2).
 */

/* ------------------------------------------------------------------ */
/* Verdict schemas (plan annex, exact)                                 */
/* ------------------------------------------------------------------ */

export interface PlanObjection {
  code: 'wrong_narrowing' | 'missing_criterion' | 'geography_mismatch' | 'criteria_misread'
  detail: string
}

export type PlanVerdict =
  | { verdict: 'sound'; objections: [] }
  | { verdict: 'unsound'; objections: PlanObjection[] }

export interface VerifyConcern {
  kind: 'factual' | 'presentational'
  detail: string
}

export type VerifyVerdict =
  | { verdict: 'verified'; concerns: [] }
  | { verdict: 'concerns'; concerns: VerifyConcern[] }
  | { verdict: 'not_verified'; concerns: VerifyConcern[] }

/** The answer's Wonder label (plan C5). */
export type WonderLabel = 'verified' | 'concerns' | 'not-run'

const PLAN_OBJECTION_CODES: ReadonlySet<string> = new Set([
  'wrong_narrowing',
  'missing_criterion',
  'geography_mismatch',
  'criteria_misread',
])

/** Parse a plan verdict; anything off-schema is null (a degradation, not a block). */
export function parsePlanVerdict(body: unknown): PlanVerdict | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (record.verdict === 'sound') return { verdict: 'sound', objections: [] }
  if (record.verdict !== 'unsound' || !Array.isArray(record.objections)) return null
  const objections: PlanObjection[] = []
  for (const entry of record.objections) {
    if (typeof entry !== 'object' || entry === null) return null
    const { code, detail } = entry as { code?: unknown; detail?: unknown }
    if (typeof code !== 'string' || !PLAN_OBJECTION_CODES.has(code)) return null
    if (typeof detail !== 'string') return null
    objections.push({ code: code as PlanObjection['code'], detail })
  }
  return { verdict: 'unsound', objections }
}

/** Parse a verify verdict; anything off-schema is null (labelled not-run upstream). */
export function parseVerifyVerdict(body: unknown): VerifyVerdict | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (
    record.verdict !== 'verified' &&
    record.verdict !== 'concerns' &&
    record.verdict !== 'not_verified'
  ) {
    return null
  }
  if (record.verdict === 'verified') return { verdict: 'verified', concerns: [] }
  if (!Array.isArray(record.concerns)) return null
  const concerns: VerifyConcern[] = []
  for (const entry of record.concerns) {
    if (typeof entry !== 'object' || entry === null) return null
    const { kind, detail } = entry as { kind?: unknown; detail?: unknown }
    if (kind !== 'factual' && kind !== 'presentational') return null
    if (typeof detail !== 'string') return null
    concerns.push({ kind, detail })
  }
  return { verdict: record.verdict, concerns }
}

/** The label a verify outcome earns (plan C5): not_verified and any failure = not-run. */
export function wonderLabelFor(verdict: VerifyVerdict | null): WonderLabel {
  if (!verdict) return 'not-run'
  if (verdict.verdict === 'verified') return 'verified'
  if (verdict.verdict === 'concerns') return 'concerns'
  return 'not-run'
}

/* ------------------------------------------------------------------ */
/* Packet builders (hard token budgets, enforced by trim)              */
/* ------------------------------------------------------------------ */

/** Rough token estimate: the budget is a ceiling, so the estimate errs long. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

export const PLAN_PACKET_TOKEN_BUDGET = 1500
export const VERIFY_PACKET_TOKEN_BUDGET = 2500

export interface PlanPacketInput {
  question: string
  intent: { mode: string; geographies: string[]; metricKeys: string[] }
  criteria: { kind: 'census' | 'research'; text: string }[]
  /** Screened subset summary: counts + deciding figures' ranges, never rows. */
  subsetSummary: { count: number; ranges: { key: string; min: number | null; max: number | null }[] }
  decisions: Record<string, string>
}

/**
 * Packet P1 (plan C2): question + parsed intent + decomposed
 * criteria + subset summary + landed decisions, <= 1,500 tokens.
 * Trim order: criteria beyond the decomposition's own cap are the
 * caller's problem; here the subset ranges compress first, then the
 * criteria list truncates from the end (the decomposition orders its
 * most central criteria first).
 *
 * The record this returns is the plan ROUTE's contract shape
 * (functions/api/muse/plan.ts): the intent's measures travel under
 * the route's `measures` key and the subset summary under `subset`
 * with string ranges. This builder previously emitted its own
 * field names (subsetSummary, metricKeys) and the route refused
 * every call pre-accounting — measured 2026-11-03: the shipped
 * client's packet bisects to 400 until exactly these two fields
 * are renamed, and diagnostics showed the plan route at zero
 * metered calls across every window, browser included.
 */
export function buildPlanPacket(input: PlanPacketInput): Record<string, unknown> {
  let ranges = input.subsetSummary.ranges.map((r) => ({
    label: r.key,
    min: r.min === null ? '' : String(r.min),
    max: r.max === null ? '' : String(r.max),
  }))
  const criteria = [...input.criteria]
  const packet = (): Record<string, unknown> => ({
    question: input.question,
    intent: {
      mode: input.intent.mode,
      geographies: input.intent.geographies,
      measures: input.intent.metricKeys,
    },
    criteria,
    subset: { count: input.subsetSummary.count, ranges },
    decisions: input.decisions,
  })
  const fits = () => estimateTokens(JSON.stringify(packet())) <= PLAN_PACKET_TOKEN_BUDGET
  if (fits()) return packet()
  ranges = []
  while (!fits() && criteria.length > 1) criteria.pop()
  return packet()
}

export interface VerifyPacketInput {
  summary: string
  places: { name: string; figures: { key: string; value: number }[] }[]
  evidence: { criterion: string; status: string; detail: string }[]
  sources: { title: string; url: string }[]
  verifySummary: string
  /** The card's display limit: places beyond it compress to a count. */
  placeDisplayLimit: number
}

/**
 * Packet P2 (plan C5): the composed answer + per-criterion evidence
 * labels + sources (capped) + the verify stage's own result summary,
 * <= 2,500 tokens, hard-trimmed.
 *
 * The record this returns is the verify ROUTE's contract shape
 * (functions/api/muse/verify.ts): the summary travels as
 * `answerText`, the places as their names, and the evidence as
 * `criteriaEvidence` entries whose label carries the status and
 * detail together. This builder previously emitted its own field
 * names (summary, evidence, place objects) and the route refused
 * every call pre-accounting — measured 2026-11-03 by bisection.
 * The place count the old record carried as `additionalPlaces`
 * still reaches the bookend inside the caller's verifySummary
 * string, which states the answer's place count verbatim.
 */
export function buildVerifyPacket(input: VerifyPacketInput): Record<string, unknown> {
  const shown = input.places.slice(0, input.placeDisplayLimit)
  const criteriaEvidence = input.evidence.map((e) => ({
    criterion: e.criterion,
    label: `${e.status} — ${e.detail}`,
  }))
  const sources = input.sources.slice(0, 12)
  const packet = (): Record<string, unknown> => ({
    answerText: input.summary,
    places: shown.map((p) => p.name),
    criteriaEvidence,
    sources,
    verifySummary: input.verifySummary,
  })
  const fits = () => estimateTokens(JSON.stringify(packet())) <= VERIFY_PACKET_TOKEN_BUDGET
  while (!fits() && sources.length > 0) sources.pop()
  while (!fits() && criteriaEvidence.length > 1) criteriaEvidence.pop()
  return packet()
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

export type PlanTransport = (packet: Record<string, unknown>) => Promise<PlanVerdict | null>
export type VerifyTransport = (packet: Record<string, unknown>) => Promise<VerifyVerdict | null>

/** Hard client timeouts (plan C5): a timeout is a degradation, never a hang. */
export const PLAN_BOOKEND_TIMEOUT_MS = 20000
export const VERIFY_BOOKEND_TIMEOUT_MS = 25000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bookend timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Translate a bookend ROUTE reply into the internal verdict shape.
 * The routes answer with an `outcome` field (their degraded outcome
 * included); the parsers above read a `verdict` field, so a route
 * reply fed to them directly parsed as null even on a 200 —
 * measured 2026-11-03: with the request shape cured, the sound and
 * verified replies still produced no client-side verdict until
 * this translation existed. A degraded outcome is not a verdict:
 * it maps to null, the degradation the labeling rule already
 * defines. The closed-schema validation itself is not duplicated:
 * the mapped record goes through the same parsers.
 */
export function planVerdictFromRouteReply(body: unknown): PlanVerdict | null {
  if (typeof body !== 'object' || body === null) return null
  const { outcome, objections } = body as { outcome?: unknown; objections?: unknown }
  if (outcome !== 'sound' && outcome !== 'unsound') return null
  return parsePlanVerdict({ verdict: outcome, objections })
}

/** The verify route's reply translation; see planVerdictFromRouteReply. */
export function verifyVerdictFromRouteReply(body: unknown): VerifyVerdict | null {
  if (typeof body !== 'object' || body === null) return null
  const { outcome, concerns } = body as { outcome?: unknown; concerns?: unknown }
  if (outcome !== 'verified' && outcome !== 'concerns' && outcome !== 'not_verified') return null
  return parseVerifyVerdict({ verdict: outcome, concerns })
}

/** The default browser transports: POST to the sibling's bookend routes. */
export function createHttpBookendTransports(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): { plan: PlanTransport; verify: VerifyTransport } {
  return {
    async plan(packet) {
      try {
        const response = await withTimeout(
          fetcher('/api/muse/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(packet),
          }),
          PLAN_BOOKEND_TIMEOUT_MS,
        )
        if (!response.ok) return null
        return planVerdictFromRouteReply(await response.json())
      } catch {
        return null
      }
    },
    async verify(packet) {
      try {
        const response = await withTimeout(
          fetcher('/api/muse/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(packet),
          }),
          VERIFY_BOOKEND_TIMEOUT_MS,
        )
        if (!response.ok) return null
        return verifyVerdictFromRouteReply(await response.json())
      } catch {
        return null
      }
    },
  }
}
