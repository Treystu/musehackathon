/**
 * Deterministic arithmetic check for the general lane (plan C13
 * refinement, owner design pass 2026-11-02 11:10 HST).
 *
 * Where a general answer STATES a computation — a Fermi product or
 * quotient chain written as an equation, a percentage-of written out
 * with its result, a rounding claim — code extracts the computation
 * and verifies the arithmetic. Jev judges the assumptions; code owns
 * the multiplication. This check is deterministic, needs no model and
 * no network, and therefore ALWAYS runs, including when the Jev route
 * is unavailable (the general lane's degradation path keeps it).
 *
 * Extraction is deliberately narrow: only computations the prose
 * itself writes as an equation are checked. A bare numeral with no
 * stated derivation is not a computation and is not judged here —
 * inventing a derivation to check would fabricate evidence. Numbers
 * may be plain, comma-grouped, decimal, or e-notation (2.2e19), the
 * shapes a Fermi derivation is actually written in.
 *
 * Tolerances, measured against how the prose is produced: a single
 * operation must match its stated result within the result's own
 * displayed rounding (half a unit of its last decimal place), so
 * 17% of 2,450 = 416.5 is exact. A chain of two or more operations
 * multiplies ROUNDED inputs (a Fermi derivation states the moon's
 * volume to two significant figures), so the product of the stated
 * inputs can drift from the stated result by the inputs' own
 * rounding; chains therefore allow 2% relative drift, and a stated
 * result outside that has an arithmetic error, not a rounding one.
 */

export interface ArithmeticFailure {
  /** The computation as written in the prose. */
  expression: string
  /** The value code computes for it. */
  expected: number
  /** The value the prose states. */
  stated: number
}

export interface ArithmeticCheckResult {
  /** How many stated computations were extracted and checked. */
  checked: number
  failures: ArithmeticFailure[]
  /** True when every extracted computation verifies (vacuously true at 0). */
  passed: boolean
}

const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e-?\d+)?`
const OP = String.raw`(?:×|\*|÷|\/| x )`

const CHAIN_RE = new RegExp(
  `(${NUM}(?:\\s*${OP}\\s*${NUM})+)\\s*=\\s*(${NUM})`,
  'g',
)
const PERCENT_RE = new RegExp(
  `(${NUM})\\s*%\\s*of\\s+(${NUM})\\s*(?:is|=|equals)\\s*(${NUM})`,
  'g',
)
const ROUND_RE = new RegExp(`(?:rounds?|rounded)\\s+to\\s+(${NUM})`, 'g')

function parseNum(raw: string): number {
  return Number(raw.replace(/,/g, ''))
}

function decimalsOf(raw: string): number {
  const cleaned = raw.replace(/,/g, '')
  if (/e-?\d+$/i.test(cleaned)) return 0
  const dot = cleaned.indexOf('.')
  return dot >= 0 ? cleaned.length - dot - 1 : 0
}

/** Displayed-rounding tolerance for a stated result, plus a chain's drift allowance. */
function toleranceFor(statedRaw: string, expected: number, chain: boolean): number {
  const rounding = 0.5 * 10 ** -decimalsOf(statedRaw)
  if (!chain) return rounding + Math.abs(expected) * 1e-9
  return Math.max(rounding, Math.abs(expected) * 0.02)
}

function evaluateChain(expression: string): number | null {
  const tokens = expression.split(/\s*(×|\*|÷|\/|x)\s*/).filter((t) => t !== '')
  if (tokens.length < 3 || tokens.length % 2 === 0) return null
  let value = parseNum(tokens[0]!)
  if (!Number.isFinite(value)) return null
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i]!
    const operand = parseNum(tokens[i + 1]!)
    if (!Number.isFinite(operand)) return null
    if (op === '×' || op === '*' || op === 'x') value *= operand
    else value /= operand
  }
  return value
}

const ROUND_UNITS: Readonly<Record<string, number>> = {
  ten: 10,
  hundred: 100,
  thousand: 1000,
}

/**
 * Check every stated computation in `prose`. `questionText` supplies
 * the rounding unit for a rounding claim ("rounded to the nearest
 * ten") when the prose itself does not repeat it.
 */
export function checkArithmetic(prose: string, questionText = ''): ArithmeticCheckResult {
  const failures: ArithmeticFailure[] = []
  let checked = 0
  // The expected values of computations verified so far, in prose
  // order: a rounding claim rounds the computation it follows.
  const verifiedExpected: number[] = []

  for (const match of prose.matchAll(PERCENT_RE)) {
    const [, pctRaw, baseRaw, statedRaw] = match as unknown as [string, string, string, string]
    const expected = (parseNum(pctRaw) / 100) * parseNum(baseRaw)
    const stated = parseNum(statedRaw)
    checked += 1
    verifiedExpected.push(expected)
    if (Math.abs(expected - stated) > toleranceFor(statedRaw, expected, false)) {
      failures.push({ expression: match[0], expected, stated })
    }
  }

  for (const match of prose.matchAll(CHAIN_RE)) {
    const [, expression, statedRaw] = match as unknown as [string, string, string]
    const expected = evaluateChain(expression)
    if (expected === null || !Number.isFinite(expected)) continue
    const stated = parseNum(statedRaw)
    checked += 1
    verifiedExpected.push(expected)
    const opCount = (expression.match(new RegExp(OP, 'g')) ?? []).length
    if (Math.abs(expected - stated) > toleranceFor(statedRaw, expected, opCount >= 2)) {
      failures.push({ expression: match[0], expected, stated })
    }
  }

  const roundContext = `${questionText} ${prose}`
  const unitMatch = /nearest\s+(ten|hundred|thousand)/i.exec(roundContext)
  const unit = unitMatch ? (ROUND_UNITS[unitMatch[1]!.toLowerCase()] ?? null) : null
  if (unit !== null && verifiedExpected.length > 0) {
    for (const match of prose.matchAll(ROUND_RE)) {
      const stated = parseNum(match[1]!)
      const expected = verifiedExpected[verifiedExpected.length - 1]!
      const rounded = Math.round(expected / unit) * unit
      checked += 1
      if (rounded !== stated) {
        failures.push({ expression: match[0], expected: rounded, stated })
      }
    }
  }

  return { checked, failures, passed: failures.length === 0 }
}

/** The named gap a failed check contributes to the J-GEN loop, verbatim-shaped. */
export function arithmeticGap(failure: ArithmeticFailure): string {
  return (
    `Arithmetic check failed: ${failure.expression} — code computes ` +
    `${failure.expected}, not ${failure.stated}`
  )
}
