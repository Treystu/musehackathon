/**
 * Briefing pack composition (server-side).
 *
 * A briefing request carries a figure set. Before any prose is
 * generated, every figure is re-verified against its source data —
 * the ported metric registry (src/core/civicscope-registry.ts), the
 * single source of truth for what a figure may be: which keys exist,
 * what unit each carries, and therefore what values are possible.
 * A figure that fails verification fails the whole request loudly:
 * no figure is silently dropped, substituted, clamped, or briefed
 * from a value its source cannot have produced.
 */
import { METRIC_DEFS_BY_KEY } from '../civicscope-registry'
import { isKnownFigureKey } from './intent-schema'
import type { BriefingRequest } from './provider'
import { isSuppressedFigure, type FigureForValidation } from './validator'

/** One figure as it arrives in a briefing request body. */
export interface BriefingFigure {
  key: string
  value: number | null
  marginOfError?: number
  vintage?: string
}

export type FigureSetVerification =
  | { ok: true; figures: FigureForValidation[] }
  | { ok: false; key: string; detail: string }

function fail(key: string, detail: string): FigureSetVerification {
  return { ok: false, key, detail }
}

/**
 * Value bounds a figure's source unit permits. Percent figures are
 * bounded 0-100; every other registry unit (dollars, counts, ratios,
 * indexes) is non-negative. Code-supplied derived figures have no
 * registry row: they get the percent bound when their name says
 * percent (`derived:renter_pct`) and the non-negative bound otherwise.
 */
function valueOutOfBounds(key: string, value: number): string | null {
  const def = METRIC_DEFS_BY_KEY.get(key)
  const isPercent = def ? def.unit === 'percent' : /(pct|percent)/i.test(key)
  if (isPercent && (value < 0 || value > 100)) {
    return `percent figure out of bounds: ${value}`
  }
  if (!isPercent && value < 0) {
    return `negative figure for a non-negative unit: ${value}`
  }
  return null
}

/**
 * Re-verify a whole figure set against source data. The set passes
 * only if every figure passes; the first failure names its figure.
 */
export function verifyFigureSet(values: readonly BriefingFigure[]): FigureSetVerification {
  const seen = new Set<string>()
  const figures: FigureForValidation[] = []
  for (const figure of values) {
    const { key } = figure
    if (!isKnownFigureKey(key)) {
      return fail(key, 'figure key not in the source registry')
    }
    if (seen.has(key)) {
      return fail(key, 'duplicate figure key in set; a pack cannot tell which value is the source value')
    }
    seen.add(key)
    if (figure.value === null || !Number.isFinite(figure.value)) {
      return fail(key, 'figure carries no value (not published or suppressed at source)')
    }
    const bounds = valueOutOfBounds(key, figure.value)
    if (bounds) return fail(key, bounds)
    if (
      figure.marginOfError !== undefined &&
      (!Number.isFinite(figure.marginOfError) || figure.marginOfError < 0)
    ) {
      return fail(key, `margin of error cannot be negative: ${figure.marginOfError}`)
    }
    if (figure.vintage !== undefined) {
      if (!/^\d{4}$/.test(figure.vintage)) {
        return fail(key, `vintage is not a 4-digit year: ${figure.vintage}`)
      }
      const year = Number(figure.vintage)
      if (year < 1900 || year > 2100) {
        return fail(key, `vintage year out of range: ${figure.vintage}`)
      }
    }
    const candidate: FigureForValidation = {
      key,
      value: figure.value,
      marginOfError: figure.marginOfError,
      vintage: figure.vintage,
    }
    if (isSuppressedFigure(candidate)) {
      return fail(key, 'figure is suppressed at source and cannot be briefed')
    }
    figures.push(candidate)
  }
  return { ok: true, figures }
}

/**
 * Compose the provider request from a verified figure set. Returns
 * the verification failure unchanged when the set does not verify.
 */
export function composeBriefingRequest(
  figureSetId: string,
  values: readonly BriefingFigure[],
): { ok: true; request: BriefingRequest; figures: FigureForValidation[] } | { ok: false; key: string; detail: string } {
  const verification = verifyFigureSet(values)
  if (!verification.ok) return verification
  return {
    ok: true,
    figures: verification.figures,
    request: {
      figureSetId,
      values: verification.figures.map((f) => ({
        key: f.key,
        value: f.value as number,
        marginOfError: f.marginOfError,
        vintage: f.vintage,
      })),
    },
  }
}
