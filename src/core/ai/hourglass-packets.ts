/**
 * Hourglass bookend packets and verdicts (C2/C5, 2026-11-02).
 *
 * Each bookend call sees a condensed packet and nothing else: the
 * packet is the call's whole world, so its budget is a hard property
 * of the builder, not a hope about input sizes. Token counts are
 * estimated at four characters per token, the conservative ratio
 * this codebase's flat token accounting already assumes; the trim
 * steps run in a fixed order (summaries compress before criteria
 * shorten, and the final hard cap cuts only what is left) so the
 * same input always builds the same packet.
 *
 * Verdict parsing is closed-schema: anything that is not exactly a
 * plan-annex verdict parses as a degradation, never as a verdict a
 * caller could act on.
 */

/** P1 (plan validation) budget, tokens. */
export const PLAN_PACKET_TOKEN_BUDGET = 1500
/** P2 (answer verification) budget, tokens. */
export const VERIFY_PACKET_TOKEN_BUDGET = 2500

const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export interface PlanPacketInput {
  question: string
  intent: { mode: string; geographies: string[]; measures: string[] }
  criteria: { kind: 'census' | 'research'; text: string }[]
  subset: { count: number; ranges: { label: string; min: string; max: string }[] }
  decisions?: Record<string, string>
}

export interface BuiltPacket {
  text: string
  tokens: number
  trimmed: boolean
}

function hardCap(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 16).trimEnd()}\n[packet trimmed]`
}

export function buildPlanPacket(input: PlanPacketInput): BuiltPacket {
  const render = (ranges: PlanPacketInput['subset']['ranges'], criteriaTextCap: number): string => {
    const lines: string[] = [
      `Question: ${input.question}`,
      `Intent: mode=${input.intent.mode}; geographies=${input.intent.geographies.join(', ') || 'none'}; measures=${input.intent.measures.join(', ') || 'none'}`,
      'Criteria:',
      ...input.criteria.map((c, i) => `${i + 1}. [${c.kind}] ${c.text.slice(0, criteriaTextCap)}`),
      `Screened subset: ${input.subset.count} places.`,
    ]
    if (ranges.length > 0) {
      lines.push(
        `Deciding figures: ${ranges.map((r) => `${r.label} ${r.min} to ${r.max}`).join('; ')}`,
      )
    }
    const decisions = Object.entries(input.decisions ?? {})
    if (decisions.length > 0) {
      lines.push(`Landed decisions: ${decisions.map(([k, v]) => `${k}=${v}`).join('; ')}`)
    }
    return lines.join('\n')
  }
  let text = render(input.subset.ranges, 200)
  // A criterion sliced by the render cap is a trim even when the
  // result already fits: the packet must not claim completeness it
  // cut away.
  let trimmed = input.criteria.some((c) => c.text.length > 200)
  if (estimateTokens(text) > PLAN_PACKET_TOKEN_BUDGET) {
    // Subset summary compresses to counts plus extrema first: the
    // deciding figures' outer ranges carry the validation signal.
    trimmed = true
    const ranges = input.subset.ranges
    const extrema = ranges.length > 2 ? [ranges[0]!, ranges[ranges.length - 1]!] : ranges
    text = render(extrema, 200)
  }
  if (estimateTokens(text) > PLAN_PACKET_TOKEN_BUDGET) {
    text = render(input.subset.ranges.slice(0, 2), 80)
  }
  if (estimateTokens(text) > PLAN_PACKET_TOKEN_BUDGET) {
    text = hardCap(text, PLAN_PACKET_TOKEN_BUDGET)
  }
  return { text, tokens: estimateTokens(text), trimmed }
}

export interface VerifyPacketInput {
  answerText: string
  places: string[]
  criteriaEvidence: { criterion: string; label: string }[]
  sources: { title: string; url: string }[]
  verifySummary: string
  /** Places shown on the card; anything beyond compresses to a count. */
  displayLimit?: number
}

export function buildVerifyPacket(input: VerifyPacketInput): BuiltPacket {
  const displayLimit = input.displayLimit ?? 10
  const render = (answerCap: number): string => {
    const shown = input.places.slice(0, displayLimit)
    const extra = input.places.length - shown.length
    const lines: string[] = [
      `Answer: ${input.answerText.slice(0, answerCap)}`,
      `Places: ${shown.join(', ') || 'none'}${extra > 0 ? ` (+${extra} more)` : ''}`,
      'Per-criterion evidence:',
      ...input.criteriaEvidence.map((c) => `- ${c.criterion}: ${c.label}`),
      `Sources: ${input.sources.slice(0, 8).map((s) => `${s.title} (${s.url})`).join('; ') || 'none'}`,
      `Deterministic verify: ${input.verifySummary}`,
    ]
    return lines.join('\n')
  }
  let text = render(4000)
  let trimmed =
    input.answerText.length > 4000 ||
    input.places.length > displayLimit ||
    input.sources.length > 8
  if (estimateTokens(text) > VERIFY_PACKET_TOKEN_BUDGET) {
    trimmed = true
    text = render(2000)
  }
  if (estimateTokens(text) > VERIFY_PACKET_TOKEN_BUDGET) {
    text = hardCap(text, VERIFY_PACKET_TOKEN_BUDGET)
  }
  return { text, tokens: estimateTokens(text), trimmed }
}

/* ------------------------------------------------------------------ */
/* Verdicts (plan annex schemas, exact)                                */
/* ------------------------------------------------------------------ */

export const PLAN_OBJECTION_CODES = [
  'wrong_narrowing',
  'missing_criterion',
  'geography_mismatch',
  'criteria_misread',
] as const
export type PlanObjectionCode = (typeof PLAN_OBJECTION_CODES)[number]

export interface PlanObjection {
  code: PlanObjectionCode
  detail: string
}

export type PlanVerdict =
  | { kind: 'sound'; objections: [] }
  | { kind: 'unsound'; objections: PlanObjection[] }
  | { kind: 'degraded' }

export type VerifyConcernKind = 'factual' | 'presentational'
export interface VerifyConcern {
  kind: VerifyConcernKind
  detail: string
}

export type VerifyVerdict =
  | { kind: 'verified'; concerns: [] }
  | { kind: 'concerns'; concerns: VerifyConcern[] }
  | { kind: 'not_verified'; concerns: VerifyConcern[] }
  | { kind: 'degraded' }

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse a plan verdict under the annex schema:
 * { verdict: 'sound' | 'unsound', objections: [{ code, detail }] }
 * with code in the closed set. Anything else is a degradation.
 */
export function parsePlanVerdict(text: string): PlanVerdict {
  const raw = extractJsonObject(text)
  if (!isRecord(raw)) return { kind: 'degraded' }
  if (raw.verdict === 'sound') return { kind: 'sound', objections: [] }
  if (raw.verdict !== 'unsound' || !Array.isArray(raw.objections)) return { kind: 'degraded' }
  const objections: PlanObjection[] = []
  for (const item of raw.objections) {
    if (
      !isRecord(item) ||
      typeof item.code !== 'string' ||
      !(PLAN_OBJECTION_CODES as readonly string[]).includes(item.code) ||
      typeof item.detail !== 'string'
    ) {
      return { kind: 'degraded' }
    }
    objections.push({ code: item.code as PlanObjectionCode, detail: item.detail })
  }
  if (objections.length === 0) return { kind: 'degraded' }
  return { kind: 'unsound', objections }
}

/**
 * Parse an answer-verification verdict under the annex schema:
 * { verdict: 'verified' | 'concerns' | 'not_verified',
 *   concerns: [{ kind: 'factual' | 'presentational', detail }] }.
 * Anything else is a degradation.
 */
export function parseVerifyVerdict(text: string): VerifyVerdict {
  const raw = extractJsonObject(text)
  if (!isRecord(raw)) return { kind: 'degraded' }
  if (raw.verdict === 'verified') return { kind: 'verified', concerns: [] }
  if (raw.verdict !== 'concerns' && raw.verdict !== 'not_verified') return { kind: 'degraded' }
  if (!Array.isArray(raw.concerns)) return { kind: 'degraded' }
  const concerns: VerifyConcern[] = []
  for (const item of raw.concerns) {
    if (
      !isRecord(item) ||
      (item.kind !== 'factual' && item.kind !== 'presentational') ||
      typeof item.detail !== 'string'
    ) {
      return { kind: 'degraded' }
    }
    concerns.push({ kind: item.kind, detail: item.detail })
  }
  if (concerns.length === 0) return { kind: 'degraded' }
  return raw.verdict === 'concerns'
    ? { kind: 'concerns', concerns }
    : { kind: 'not_verified', concerns }
}
