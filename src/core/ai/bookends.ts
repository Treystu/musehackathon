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
 */
export function buildPlanPacket(input: PlanPacketInput): Record<string, unknown> {
  const packet: Record<string, unknown> = {
    question: input.question,
    intent: input.intent,
    criteria: [...input.criteria],
    subsetSummary: input.subsetSummary,
    decisions: input.decisions,
  }
  const fits = () => estimateTokens(JSON.stringify(packet)) <= PLAN_PACKET_TOKEN_BUDGET
  if (fits()) return packet
  packet.subsetSummary = { count: input.subsetSummary.count, ranges: [] }
  while (!fits() && (packet.criteria as unknown[]).length > 1) {
    ;(packet.criteria as unknown[]).pop()
  }
  return packet
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
 */
export function buildVerifyPacket(input: VerifyPacketInput): Record<string, unknown> {
  const shown = input.places.slice(0, input.placeDisplayLimit)
  const packet: Record<string, unknown> = {
    summary: input.summary,
    places: shown,
    ...(input.places.length > shown.length
      ? { additionalPlaces: input.places.length - shown.length }
      : {}),
    evidence: [...input.evidence],
    sources: input.sources.slice(0, 12),
    verifySummary: input.verifySummary,
  }
  const fits = () => estimateTokens(JSON.stringify(packet)) <= VERIFY_PACKET_TOKEN_BUDGET
  while (!fits() && (packet.sources as unknown[]).length > 0) {
    ;(packet.sources as unknown[]).pop()
  }
  while (!fits() && (packet.evidence as unknown[]).length > 1) {
    ;(packet.evidence as unknown[]).pop()
  }
  return packet
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
        return parsePlanVerdict(await response.json())
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
        return parseVerifyVerdict(await response.json())
      } catch {
        return null
      }
    },
  }
}
