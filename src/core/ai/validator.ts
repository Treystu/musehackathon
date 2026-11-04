/**
 * Fail-closed numeral-provenance validator (full implementation).
 *
 * 6-step order:
 *  0 pre-generation intent gate (`intentGate`)
 *  1 allowed-numeral set built from supplied figures only
 *  2 numeral scan (digits + closed word-form table)
 *  3 provenance match within displayed rounding tolerance
 *  4 precision / MOE-CI overlap for comparative or strong claims
 *  5 banned constructions (ranking / recommendation / steering /
 *    proxy characterisation)
 *  6 disposition: pass, or withhold with a failure class
 *
 * No numeral is ever computed here from other figures. A derived
 * percentage is allowed only when code computed it elsewhere and
 * passed it in as a figure (conventionally key `derived:<name>`).
 */
import {
  isDisplayableKey,
  isFilterLegal as isFilterLegalKey,
  isRankLegal as isRankLegalKey,
} from './intent-schema'

export interface FigureForValidation {
  key: string
  value: number | null
  marginOfError?: number
  vintage?: string
  /** Explicit suppression marker; suppressed figures are treated as absent. */
  suppressed?: boolean
}

export const VALIDATOR_FAILURES = [
  'intent_gate',
  'invented_numeral',
  'precision',
  'banned_construction',
] as const

export type ValidatorFailure = (typeof VALIDATOR_FAILURES)[number]

export type ValidatorVerdict =
  | { pass: true }
  | { pass: false; failure: ValidatorFailure; detail: string }

export interface Validator {
  validate(prose: string, figures: FigureForValidation[]): ValidatorVerdict
}

export const DISCLOSURE_TEXT =
  "Figures are CivicScope's (source and vintage shown with each figure). Wording is Muse Spark's. This is a reading of the shown figures, not an additional source."

/** Small counts below this are suppressed and treated as absent. Counts only. */
export const SMALL_COUNT_SUPPRESSION_THRESHOLD = 20

/**
 * Count-figure recognition for small-count suppression. The workbench
 * carries no METRIC_DEFS unit/type metadata, so non-count figures are
 * recognized by the key-naming conventions this codebase already relies
 * on: percentages (`pct`/`percent`, cf. isPercentKey), medians
 * (`median_` — dollars, years, or a burden percentage, never a count),
 * and averages (`average_`). Every other key is treated as a count —
 * including unknown keys, which fail closed and keep small-count
 * suppression. Verified against all 15 audit-documented METRIC_DEFS
 * keys; METRIC_DEFS unit/type fields remain the ground truth at port
 * time and are deliberately not re-invented here.
 */
function isCountKey(key: string): boolean {
  return !/(pct|percent|median_|average_)/i.test(key)
}

export function isSuppressedFigure(figure: FigureForValidation): boolean {
  if (figure.suppressed) return true
  if (figure.value === null || !Number.isFinite(figure.value)) return true
  if (!isCountKey(figure.key)) return false
  return Math.abs(figure.value) < SMALL_COUNT_SUPPRESSION_THRESHOLD
}

function usableFigures(
  figures: FigureForValidation[],
  smallCountSuppression = true,
): FigureForValidation[] {
  if (smallCountSuppression) return figures.filter((f) => !isSuppressedFigure(f))
  // Without the small-count rule, a figure is unusable only when it is
  // explicitly suppressed or carries no finite value. The distinction
  // matters for figures the reader stated themselves (see
  // checkNumeralProvenance): suppression exists to keep tiny Census
  // counts out of generated prose, and a stated figure is provenance
  // by definition — suppressing it would manufacture a mismatch.
  return figures.filter(
    (f) => !f.suppressed && f.value !== null && Number.isFinite(f.value),
  )
}

/* ------------------------------------------------------------------ */
/* Step 0: pre-generation intent gate                                  */
/* ------------------------------------------------------------------ */

const PROXY_OR_SENSITIVE_KEY =
  /(race|racial|ethnic|relig|gender|sex|famil|marital|veteran|national|minority|hispanic|latino|black|white|asian|disab|school|health|asthma|medical|crime|demograph)/i

function keysFromValue(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) keysFromValue(item, out)
    return
  }
  if (typeof value === 'object' && value !== null) {
    const r = value as Record<string, unknown>
    for (const field of ['metricKey', 'metric', 'key', 'field', 'name', 'sortBy', 'sortKey']) {
      if (typeof r[field] === 'string') out.push(r[field] as string)
    }
    for (const field of ['metricKeys', 'metrics', 'keys', 'components', 'filters', 'values']) {
      if (r[field] !== undefined) keysFromValue(r[field], out)
    }
  }
}

function rejectIntent(detail: string): ValidatorVerdict {
  return { pass: false, failure: 'intent_gate', detail }
}

/**
 * Mechanical fair-housing gate, run before generation. Rejects any
 * proxy / school / health (i.e. non-filter-legal) key used to filter
 * or build a composite, and any non-rank-legal key used to sort, rank
 * by similarity, or drive a sweep. The two standards differ since the
 * owner's 2026-11-03 ruling made median_age rank-legal: it may order
 * a screen (sort keys, sweep/similarity measures) but still may never
 * filter. Displayable-but-not-rank-legal keys (e.g. `renter_occupied`,
 * `below_poverty_count`) are exactly the keys blocked as measures here.
 * Lookup/compare display keys are not filtered
 * by this gate, except explicit demographic-proxy keys.
 */
export function intentGate(
  intent: unknown,
  figures?: FigureForValidation[],
): ValidatorVerdict {
  if (typeof intent !== 'object' || intent === null) {
    return rejectIntent('intent must be an object')
  }
  const r = intent as Record<string, unknown>
  const mode = typeof r.mode === 'string' ? r.mode.toLowerCase() : ''

  if (figures) {
    const suppressedKeys = new Set(
      figures.filter(isSuppressedFigure).map((f) => f.key),
    )
    const referenced: string[] = []
    keysFromValue(r.metricKeys, referenced)
    keysFromValue(r.filters, referenced)
    for (const k of referenced) {
      if (suppressedKeys.has(k)) {
        return rejectIntent(`suppressed figure cannot be used: ${k}`)
      }
    }
  }

  const filterKeys: string[] = []
  keysFromValue(r.filters, filterKeys)
  keysFromValue(r.filter, filterKeys)

  const sortKeys: string[] = []
  for (const field of ['sort', 'sortBy', 'sortKey', 'orderBy', 'ordering', 'sorts']) {
    keysFromValue(r[field], sortKeys)
  }

  const similarityKeys: string[] = []
  keysFromValue(r.similarity, similarityKeys)
  keysFromValue(r.similarityKeys, similarityKeys)

  const compositeKeys: string[] = []
  keysFromValue(r.composite, compositeKeys)
  keysFromValue(r.compositeKeys, compositeKeys)
  keysFromValue(r.components, compositeKeys)

  const metricKeys: string[] = []
  keysFromValue(r.metricKeys, metricKeys)

  const checkFilterLegal = (keys: string[], context: string): ValidatorVerdict | null => {
    for (const k of keys) {
      if (!isFilterLegalKey(k)) {
        const kind = PROXY_OR_SENSITIVE_KEY.test(k)
          ? 'proxy/school/health key'
          : isDisplayableKey(k)
            ? 'displayable but not filter-legal key'
            : 'key not filter-legal'
        return rejectIntent(`${context} uses ${kind}: ${k}`)
      }
    }
    return null
  }

  // The ranking standard: a key that may ORDER a screen. Rank-legal is
  // filter-legal plus median_age (owner ruling 2026-11-03); everything
  // displayable beyond that (poverty, attainment, broadband, crowding,
  // tenure, population) still refuses as a ranking input.
  const checkRankLegal = (keys: string[], context: string): ValidatorVerdict | null => {
    for (const k of keys) {
      if (!isRankLegalKey(k)) {
        const kind = PROXY_OR_SENSITIVE_KEY.test(k)
          ? 'proxy/school/health key'
          : isDisplayableKey(k)
            ? 'displayable but not rank-legal key'
            : 'key not rank-legal'
        return rejectIntent(`${context} uses ${kind}: ${k}`)
      }
    }
    return null
  }

  const gated: Array<[string[], string]> = [
    [filterKeys, 'filter'],
    [compositeKeys, 'composite'],
  ]
  for (const [keys, context] of gated) {
    const bad = checkFilterLegal(keys, context)
    if (bad) return bad
  }
  const badSort = checkRankLegal(sortKeys, 'sort')
  if (badSort) return badSort
  const badSimilarity = checkRankLegal(similarityKeys, 'similarity')
  if (badSimilarity) return badSimilarity

  if (mode === 'similarity' || mode === 'composite') {
    const bad = checkRankLegal(metricKeys, mode)
    if (bad) return bad
  }
  if (mode === 'sweep_filter' || mode === 'filter' || mode === 'sweep' || mode === 'sort') {
    const bad = checkRankLegal(metricKeys, mode)
    if (bad) return bad
  }

  // Demographic-proxy keys are blocked in every mode, including lookup.
  for (const k of [...metricKeys, ...filterKeys, ...sortKeys]) {
    if (
      /(race|racial|ethnic|relig|gender|marital|veteran|national_origin|minority|hispanic|latino|demograph)/i.test(k) &&
      !isFilterLegalKey(k)
    ) {
      return rejectIntent(`proxy key blocked: ${k}`)
    }
  }

  return { pass: true }
}

/* ------------------------------------------------------------------ */
/* Steps 1-3: allowed set, scan, provenance                            */
/* ------------------------------------------------------------------ */

interface AllowedNumeral {
  value: number
  isPercent: boolean
  key: string
}

function isPercentKey(key: string): boolean {
  return /(pct|percent)/i.test(key)
}

function buildAllowedSet(
  figures: FigureForValidation[],
  opts?: { suppressSmallCounts?: boolean },
): AllowedNumeral[] {
  const allowed: AllowedNumeral[] = []
  for (const f of usableFigures(figures, opts?.suppressSmallCounts !== false)) {
    const value = f.value as number
    const pct = isPercentKey(f.key)
    allowed.push({ value, isPercent: pct, key: f.key })
    if (typeof f.marginOfError === 'number' && Number.isFinite(f.marginOfError)) {
      const moe = Math.abs(f.marginOfError)
      if (moe > 0) {
        allowed.push({ value: moe, isPercent: pct, key: f.key })
        allowed.push({ value: value + moe, isPercent: pct, key: f.key })
        allowed.push({ value: value - moe, isPercent: pct, key: f.key })
      }
    }
    if (f.vintage) {
      for (const m of f.vintage.matchAll(/\d{4}/g)) {
        allowed.push({ value: Number(m[0]), isPercent: false, key: f.key })
      }
    }
  }
  return allowed
}

export interface FoundNumeral {
  raw: string
  value: number
  isPercent: boolean
  decimals: number
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
}
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}
const SCALES: Readonly<Record<string, number>> = {
  hundred: 100, thousand: 1_000, million: 1_000_000,
}

function scanDigitNumerals(prose: string, out: FoundNumeral[]): void {
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*(?:%|percent\b|per\s+cent\b))?/g
  for (const m of prose.matchAll(re)) {
    const raw = m[0]
    const numPart = (m[1] as string).replace(/,/g, '')
    const dot = numPart.indexOf('.')
    out.push({
      raw,
      value: Number(numPart),
      isPercent: Boolean(m[2]),
      decimals: dot >= 0 ? numPart.length - dot - 1 : 0,
    })
  }
}

function parseWordNumber(words: string[], start: number): { value: number; next: number } | null {
  let i = start
  let group = 0
  let total = 0
  let started = false

  // "a hundred" / "a thousand"
  if ((words[i] === 'a' || words[i] === 'an') && words[i + 1] !== undefined && (words[i + 1] as string) in SCALES) {
    group = 1
    started = true
    i++
  }
  while (i < words.length) {
    const w = words[i] as string
    if (w in UNITS) {
      group += UNITS[w] as number
      started = true
      i++
    } else if (w in TENS) {
      group += TENS[w] as number
      started = true
      i++
    } else if (w === 'hundred') {
      group = (group || 1) * 100
      started = true
      i++
    } else if (w === 'thousand' || w === 'million') {
      total += (group || 1) * (SCALES[w] as number)
      group = 0
      started = true
      i++
    } else if (w === 'and' && started && i + 1 < words.length &&
      ((words[i + 1] as string) in UNITS || (words[i + 1] as string) in TENS)) {
      i++
    } else {
      break
    }
  }
  if (!started) return null
  return { value: total + group, next: i }
}

function scanWordNumerals(prose: string, out: FoundNumeral[]): void {
  const words = prose.toLowerCase().match(/[a-z]+/g) ?? []
  let i = 0
  while (i < words.length) {
    const parsed = parseWordNumber(words, i)
    if (!parsed || parsed.next === i) {
      i++
      continue
    }
    let isPercent = false
    let next = parsed.next
    if (words[next] === 'percent' || words[next] === 'percentage') {
      isPercent = true
      next++
    } else if (words[next] === 'per' && words[next + 1] === 'cent') {
      isPercent = true
      next += 2
    }
    out.push({
      raw: words.slice(i, next).join(' '),
      value: parsed.value,
      isPercent,
      decimals: 0,
    })
    i = next
  }
}

export function scanNumerals(prose: string): FoundNumeral[] {
  const out: FoundNumeral[] = []
  scanDigitNumerals(prose, out)
  scanWordNumerals(prose, out)
  return out
}

function roundingTolerance(found: FoundNumeral): number {
  return 0.5 * 10 ** -found.decimals
}

function matchesAllowed(found: FoundNumeral, allowed: AllowedNumeral[]): boolean {
  const tol = roundingTolerance(found)
  return allowed.some((a) => {
    if (Math.abs(found.value - a.value) > tol) return false
    // A percent claim needs a percent/derived-percent source; a bare
    // numeral may cite a percent figure's value.
    if (found.isPercent && !a.isPercent) return false
    return true
  })
}

/**
 * Numeral provenance ONLY — steps 1-3 without the precision step or
 * the banned-construction scan. This is the check for text the reader
 * supplied themselves (a speech transcript): the question it answers
 * is exactly "does every numeral in these words match a supplied
 * figure". The full validate() below judges GENERATED prose, where
 * precision and construction rules police what the model may say; a
 * reader asking for "the best schools" is stating their criterion,
 * not making a ranking claim, and running the prose scan over their
 * words hard-blocked ordinary spoken questions on a failure class
 * that had nothing to do with numerals (measured 2026-11-02: the
 * transcript "what city has the best schools but also has", against
 * an intent carrying no figures at all, failed banned_construction
 * on the word "best" and the run dead-ended under a note blaming a
 * numeral). Small-count suppression does not apply here: the figures
 * supplied on this path are the reader's own stated request values,
 * provenance by definition.
 */
export function checkNumeralProvenance(
  prose: string,
  figures: FigureForValidation[],
): ValidatorVerdict {
  if (!prose || !prose.trim()) return { pass: true }
  const safeFigures = Array.isArray(figures) ? figures : []
  const allowed = buildAllowedSet(safeFigures, { suppressSmallCounts: false })
  const found = scanNumerals(prose)
  for (const n of found) {
    if (!matchesAllowed(n, allowed)) {
      return {
        pass: false, failure: 'invented_numeral',
        detail: `numeral not in supplied figures: ${n.raw} (${n.value})`,
      }
    }
  }
  return { pass: true }
}

/** True when one scanned numeral cites one supplied figure (same tolerance and percent rules as the provenance check). */
export function numeralMatchesFigure(
  found: FoundNumeral,
  figure: FigureForValidation,
): boolean {
  return matchesAllowed(
    found,
    buildAllowedSet([figure], { suppressSmallCounts: false }),
  )
}

/* ------------------------------------------------------------------ */
/* Step 4: precision / MOE-CI overlap                                  */
/* ------------------------------------------------------------------ */

const HEDGE_RE =
  /\b(about|approximately|approx\.|roughly|around|estimated?|uncertain(?:ty)?|margin of error|could|might|may be|wide|imprecise|caution)\b/i
const STRONG_RE =
  /\b(exactly|precisely|definitely|certainly|clearly|significantly|undoubtedly|proves?|proven|guaranteed)\b/i
const COMPARATIVE_RE =
  /\b(higher|lower|greater|fewer|more|less)\b[^.!?]*\bthan\b|\b(exceeds?|exceeded|outpaces?|outpaced)\b/i

function precisionFailure(
  prose: string,
  figures: FigureForValidation[],
  found: FoundNumeral[],
): ValidatorVerdict | null {
  const usable = usableFigures(figures)
  const moeFigures = usable.filter(
    (f) => typeof f.marginOfError === 'number' && (f.marginOfError as number) > 0,
  )
  const lower = prose.toLowerCase()
  const hedged = HEDGE_RE.test(lower)

  if (STRONG_RE.test(lower) && moeFigures.length > 0) {
    return {
      pass: false, failure: 'precision',
      detail: 'strong or exact claim made despite a margin of error',
    }
  }

  if (COMPARATIVE_RE.test(lower) && moeFigures.length >= 2) {
    const bands = moeFigures.map((f) => {
      const v = f.value as number
      const m = Math.abs(f.marginOfError as number)
      return { lo: v - m, hi: v + m }
    })
    for (let a = 0; a < bands.length; a++) {
      for (let b = a + 1; b < bands.length; b++) {
        const A = bands[a] as { lo: number; hi: number }
        const B = bands[b] as { lo: number; hi: number }
        if (A.lo <= B.hi && B.lo <= A.hi) {
          return {
            pass: false, failure: 'precision',
            detail: 'comparative claim made while margin-of-error bands overlap',
          }
        }
      }
    }
  } else if (COMPARATIVE_RE.test(lower) && moeFigures.length === 1) {
    const f = moeFigures[0] as FigureForValidation
    const v = f.value as number
    const m = Math.abs(f.marginOfError as number)
    const otherInside = usable.some(
      (o) => o !== f && o.value !== null && o.value >= v - m && o.value <= v + m,
    )
    if (otherInside) {
      return {
        pass: false, failure: 'precision',
        detail: 'comparative claim falls inside the margin-of-error band',
      }
    }
  }

  if (!hedged) {
    for (const f of moeFigures) {
      const v = f.value as number
      const m = Math.abs(f.marginOfError as number)
      const wide = v !== 0 ? m / Math.abs(v) >= 0.25 : m > 0
      if (!wide) continue
      const cited = found.some((n) => Math.abs(n.value - v) <= roundingTolerance(n))
      if (cited) {
        return {
          pass: false, failure: 'precision',
          detail: 'unhedged precise claim for a wide confidence interval figure',
        }
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Step 5: banned constructions                                        */
/* ------------------------------------------------------------------ */

/**
 * Constructions withheld in EVERY context, including criteria-grounded
 * answers: steering, personal recommendation, superlative ranking, and
 * characterisation of a place by who lives there. A superlative is
 * withheld even in the grounded context because it is a ranking claim
 * beyond the reader's stated criteria — the screened figures ground
 * "meets the bound", never "best".
 */
const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // ranking / superlative evaluation
  { re: /\b(best|worst|finest|greatest|nicest|number one|no\.?\s*1|highest-ranked|lowest-ranked|top-ranked)\b/i, label: 'ranking' },
  // recommendation
  { re: /\b(recommend(?:s|ed|ation)?|should move|should live|should buy|should rent|should choose|you should|we suggest|ideal for|perfect for)\b/i, label: 'recommendation' },
  // steering
  { re: /\b(should move|move here|move to this|relocate here|settle (in|here)|stay away from|avoid this (area|neighbourhood|neighborhood))\b/i, label: 'steering' },
  // evaluative / proxy characterisation of a place
  { re: /\b(good|bad|safe|unsafe|dangerous|desirable|undesirable|sketchy)\s+(neighbourhood|neighborhood|area|district|community)\b/i, label: 'proxy characterisation' },
  { re: /\bgood neighbourhood\b|\bgood neighborhood\b/i, label: 'proxy characterisation' },
  { re: /\b(family-friendly|family friendly|great for families|good for families|up-and-coming)\b/i, label: 'proxy characterisation' },
  { re: /\b(mostly|predominantly|mainly|largely)\s+(renters?|tenants?|owners?|families|black|white|hispanic|latino|asian|minority|ethnic|religious|christian|muslim|jewish|immigrant|foreign-born)\b/i, label: 'proxy characterisation' },
  { re: /\b(renter|tenant|owner|black|white|hispanic|latino|asian|minority|ethnic|christian|muslim|jewish|immigrant)[-\s]+(area|neighbourhood|neighborhood|community|district)\b/i, label: 'proxy characterisation' },
]

/**
 * Constructions banned only in the strict (figure-prose) context.
 * In a criteria-grounded research answer these report the reader's own
 * stated criteria from cited sources — a school criterion the Census
 * cannot serve is exactly what the research stage exists to answer —
 * so the citation gate, not this scan, is their grounding mechanism.
 * Figure prose (explain / briefing) keeps the strict scan: it is a
 * reading of shown figures and has no school criterion to report.
 */
const STRICT_ONLY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\btop\b|\branked\b|\branking\b/i, label: 'ranking' },
  { re: /\b(good schools?|bad schools?)\b/i, label: 'proxy characterisation' },
]

export interface BannedConstructionContext {
  /**
   * True when the prose is a criteria-grounded answer or the research
   * behind one: it names places against the reader's own stated
   * criteria, with the deciding figures or cited sources shown.
   * Rescoped 2026-11-02 (owner directive, Jev-gated proceed): the
   * shipped "never rank or recommend" posture withheld even naming
   * the places that meet the reader's criteria. Naming those places
   * passes now; the BANNED_PATTERNS above still withhold in this
   * context — steering or characterising by race, ethnicity, religion,
   * or national origin, personal recommendation, and any superlative
   * or ranking claim the criteria do not ground.
   */
  criteriaGrounded?: boolean
}

/**
 * The banned-construction scan on its own, for prose the numeral
 * steps cannot judge. Research ("From the web") prose legitimately
 * carries figures from its cited sources, so provenance checking
 * does not apply to it — but ranking, recommendation, steering, and
 * proxy characterisation are banned there exactly as in figure
 * prose, and until 2026-11-02 nothing scanned research prose at
 * all: it was prompt-guarded and citation-gated only, while the
 * shipped privacy text claims mechanical gates. Returns the matched
 * construction's label, or null when the prose is clean.
 */
export function findBannedConstruction(
  prose: string,
  context?: BannedConstructionContext,
): string | null {
  for (const { re, label } of BANNED_PATTERNS) {
    if (re.test(prose)) return label
  }
  if (!context?.criteriaGrounded) {
    for (const { re, label } of STRICT_ONLY_PATTERNS) {
      if (re.test(prose)) return label
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Validator                                                           */
/* ------------------------------------------------------------------ */

export function createValidator(): Validator & {
  intentGate: typeof intentGate
} {
  const validator = {
    intentGate,
    validate(prose: string, figures: FigureForValidation[]): ValidatorVerdict {
      if (!prose || !prose.trim()) return { pass: true }
      const safeFigures = Array.isArray(figures) ? figures : []

      // Steps 1-3: provenance. Nothing is computed from figures here;
      // derived values pass only if supplied as figures themselves.
      const allowed = buildAllowedSet(safeFigures)
      const found = scanNumerals(prose)
      for (const n of found) {
        if (!matchesAllowed(n, allowed)) {
          return {
            pass: false, failure: 'invented_numeral',
            detail: `numeral not in supplied figures: ${n.raw} (${n.value})`,
          }
        }
      }

      // Step 4: precision / MOE-CI overlap.
      const precision = precisionFailure(prose, safeFigures, found)
      if (precision) return precision

      // Step 5: banned constructions.
      const banned = findBannedConstruction(prose)
      if (banned) {
        return {
          pass: false, failure: 'banned_construction',
          detail: `banned construction: ${banned}`,
        }
      }

      // Step 6: disposition.
      return { pass: true }
    },
  }
  return validator
}

export const realValidator: Validator = createValidator()

/**
 * Back-compat alias. Existing imports of `hermeticStubValidator`
 * (and the hermetic tests relying on its pass-empty / withhold-digit
 * contract) keep working against the real validator.
 */
export const hermeticStubValidator: Validator = realValidator
