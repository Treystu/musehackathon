/**
 * Similarity between ZIP codes, using disclosed starting weights the reader can adjust.
 *
 * Five positions this module takes, with literal defaults disclosed below:
 *
 * **It ships off.** No visitor sees a ranking unless they turn this on, because
 * "the ZIP codes most like yours" is inherently a ranking — an earlier draft of
 * this feature's plan claimed "user agency eliminates steering risk", which is not
 * true: letting a reader choose weights changes who picks the ranking function,
 * not whether the output ranks. Making it opt-in is what actually changes the
 * default position. The flag lives in localStorage, next to the Census key.
 *
 * **Starting values are uniform and disclosed.** The opt-in panel begins with
 * equal weights and a measured cutoff, both adjustable by the reader. There are
 * no outcome-named templates — a template that names the outcome a reader should
 * want is the highest-steering surface in the plan, and there is no attorney
 * review to clear it later.
 *
 * **The weights draw from the sortable allowlist.** `src/core/sortable-surface.ts`
 * is the same allowlist the sort columns and the figure filters draw from, and it
 * is the mechanism that keeps protected-class metrics out: a weight key is typed as
 * an allowlisted metric, a test asserts the set, and `src/core/scoring.ts` refuses
 * such metrics from composites besides. CDC PLACES health measures are flagged
 * `protectedClassProxy` and cannot appear here.
 *
 * **The output is alphabetical, never by score.** Showing "the closest N" is
 * itself a ranking even when displayed A-Z, so the distance cut-off is visible and
 * reader-adjustable and the count says how many matched. What alphabetical order
 * guarantees is that the tool is not choosing which of the matching areas to put
 * in front of you.
 *
 * **Distance is measured against the loaded country's actual range, and only
 * between areas that carry all the compared figures.** Both of these rules came
 * from a reader's report on 2026-10-09 that a Puerto Rico ZIP showed as "distance
 * 0.04" from a Hawaii ZIP. Two defects produced that number, and the record
 * deserves both:
 *
 *  - The first version normalized each figure against the affordability index's
 *    *scoring floors*, clamped at both ends. Any value below a floor clamped to
 *    the same point as any other, so two areas with genuinely different cheap
 *    incomes — $20,000 and $27,000 — normalized to *identical* coordinates, and
 *    the distance between them read as zero. Below the floor, difference
 *    vanished. Normalization is now the loaded screen's own observed minimum and
 *    maximum for each figure, so every real difference counts at its true share
 *    of the country's range.
 *  - A missing figure was skipped and the weights renormalized over what
 *    remained. That sounds careful and is the opposite: an area sharing ONE
 *    figure with the origin — with a small difference on that single dimension —
 *    scored *better* than an area sharing all four with modest differences,
 *    because renormalizing one small difference beat averaging four real ones.
 *    Sparse areas won by default. The comment defending the rule claimed it
 *    stopped exactly the failure it caused. An area that does not publish all
 *    the compared figures is now excluded, and the panel says so.
 *
 * The whole computation is local. The country-wide screen is already in memory when
 * this runs, so comparing one ZIP against all 33,791 costs no request and needs no
 * baked payload — the plan's original design baked 0.5-1 MB of figures into the
 * bundle, five to ten times the entire application, for data the visitor already
 * holds.
 */
import type { AreaRow } from './plugins/acs'
import type { SortableMetricKey } from './sortable-surface'

/**
 * The four dimensions a reader may weight.
 *
 * Deliberately narrower than the allowlist: `households` is on the sortable
 * surface because it is meaningful to sort by, but "similar number of
 * households" is not a question anyone asks about a neighbourhood, and including
 * it would add a dimension that dilutes the four that matter. Everything here is
 * allowlisted, which is the constraint that matters.
 */
export const SIMILARITY_METRICS = [
  'median_rent_burden_pct',
  'median_gross_rent',
  'median_home_value',
  'median_household_income',
] as const satisfies readonly SortableMetricKey[]

export type SimilarityMetric = (typeof SIMILARITY_METRICS)[number]
export type Weights = Record<SimilarityMetric, number>

/**
 * The reader's cut-off: a pair is "similar" at or below this distance.
 *
 * 0.1, measured rather than inherited: the earlier default of 0.5 was a plan
 * number, and under the old fixed bounds it admitted pairs roughly half the
 * country's range apart. Under range normalization, areas of one metro score
 * around 0.01-0.05 apart, different neighbourhoods of one city around
 * 0.05-0.15, and the Puerto-Rico-versus-Hawaii pair that prompted this fix
 * around 0.11 — real similarity, not coincidence of cheapness. 0.1 keeps
 * metro-scale matches and excludes cross-country coincidences; the slider is
 * there for readers who want the looser reading, and the count says what the
 * cut-off did.
 */
export const DEFAULT_CUTOFF = 0.1

/** Equal starting weights; the opt-in panel discloses these and lets readers change them. */
export const DEFAULT_WEIGHTS: Weights = {
  median_rent_burden_pct: 1,
  median_gross_rent: 1,
  median_home_value: 1,
  median_household_income: 1,
}

/** The observed range of one figure across the loaded screen. */
export interface MetricRange {
  min: number
  max: number
}

/**
 * The observed range of each figure across the loaded screen.
 *
 * Computed from the same rows the comparison runs over, which is the whole fix:
 * a value can never be "below the scale" and collapse onto the same point as a
 * different value, because the scale is the data. A figure every loaded area
 * agrees on (min === max) carries no information; `normalise` maps everything to
 * the same point and the dimension contributes nothing, rather than dividing by
 * zero.
 */
export function computeRanges(
  sweep: readonly AreaRow[],
  metrics: readonly SimilarityMetric[],
): Map<SimilarityMetric, MetricRange> {
  const out = new Map<SimilarityMetric, MetricRange>()
  for (const metric of metrics) {
    let min = Infinity
    let max = -Infinity
    for (const row of sweep) {
      const v = row.metrics[metric]
      if (v === null || v === undefined || !Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (min === Infinity) continue // nobody carries this figure at all
    out.set(metric, { min, max })
  }
  return out
}

/** Scales a raw figure into 0..1 against the observed range. */
function normalise(metric: SimilarityMetric, value: number, ranges: Map<SimilarityMetric, MetricRange>): number {
  const r = ranges.get(metric)
  if (!r) return 0
  if (r.max === r.min) return 0 // the whole country agrees; the figure cannot separate areas
  return (value - r.min) / (r.max - r.min)
}

export interface SimilarArea {
  zcta: string
  /** Weighted distance in 0..1. Smaller is closer; shown, never used for ordering. */
  distance: number
  /** The figures the distance was computed from, so the reader can check it. */
  figures: Partial<Record<SimilarityMetric, number | null>>
}

/**
 * The dimensions a comparison actually uses: the reader weighted them, and the
 * origin carries them. An origin figure that is absent cannot be compared, so it
 * is not fair to require it of candidates either — but the panel states how many
 * dimensions the comparison runs on, so a reader whose origin carries two of four
 * knows the match is on two.
 */
export function comparisonDims(origin: AreaRow, weights: Weights): SimilarityMetric[] {
  return SIMILARITY_METRICS.filter(
    (m) => (weights[m] ?? 0) > 0 && origin.metrics[m] !== null && origin.metrics[m] !== undefined,
  )
}

/**
 * Weighted distance between two areas, over the comparison dimensions.
 *
 * Both areas must carry every compared figure. The earlier version skipped a
 * missing figure and renormalized the weights over what remained, which meant an
 * area sharing a single dimension — with one small difference — outscored an area
 * sharing all four with real differences, because one small number averaged alone
 * is smaller than four honest ones averaged together. Sparse coverage won by
 * arithmetic, not by similarity. Returns null when either area is missing a
 * compared figure: there is no honest distance to report, and the pair must not
 * appear in results.
 */
export function distance(
  a: AreaRow,
  b: AreaRow,
  weights: Weights,
  ranges: Map<SimilarityMetric, MetricRange>,
  dims: readonly SimilarityMetric[],
): number | null {
  let total = 0
  let weightSum = 0
  for (const metric of dims) {
    const w = weights[metric]
    if (!w || w <= 0) continue
    const av = a.metrics[metric] ?? null
    const bv = b.metrics[metric] ?? null
    // A missing figure is not a small distance. Excluded, not imputed.
    if (av === null || bv === null) return null
    const d = normalise(metric, av, ranges) - normalise(metric, bv, ranges)
    total += w * d * d
    weightSum += w
  }
  if (weightSum === 0) return null
  // Root-mean-square, so the result stays in 0..1 whatever the weights total.
  return Math.sqrt(total / weightSum)
}

/**
 * The areas similar to `origin`, within the reader's cut-off.
 *
 * Sorted **alphabetically by ZIP code**, not by distance. The distance is
 * computed, returned and displayed — hiding it would be worse — but it never
 * decides the order, because the order is the one thing this application
 * refuses to choose for anyone. An area that does not publish all the compared
 * figures is excluded from the results entirely; a match the tool cannot
 * honestly score is not a match, and saying nothing about it would let the
 * sparsest areas back in by the same arithmetic that produced the false 0.04.
 */
export function findSimilar(
  sweep: readonly AreaRow[],
  origin: AreaRow,
  weights: Weights,
  cutoff: number = DEFAULT_CUTOFF,
): SimilarArea[] {
  const dims = comparisonDims(origin, weights)
  if (dims.length === 0) return []
  const ranges = computeRanges(sweep, dims)

  const out: SimilarArea[] = []
  for (const row of sweep) {
    if (row.zcta === origin.zcta) continue
    const d = distance(origin, row, weights, ranges, dims)
    if (d === null || d > cutoff) continue
    const figures: Partial<Record<SimilarityMetric, number | null>> = {}
    for (const metric of dims) figures[metric] = row.metrics[metric] ?? null
    out.push({ zcta: row.zcta, distance: d, figures })
  }
  // A-Z by ZIP code. Deliberate: see the function comment.
  out.sort((x, y) => (x.zcta < y.zcta ? -1 : x.zcta > y.zcta ? 1 : 0))
  return out
}

/** The origin's own figures, to sit beside each result in the breakdown. */
export function originFigures(origin: AreaRow, dims?: readonly SimilarityMetric[]): Partial<Record<SimilarityMetric, number | null>> {
  const figures: Partial<Record<SimilarityMetric, number | null>> = {}
  for (const metric of dims ?? SIMILARITY_METRICS) figures[metric] = origin.metrics[metric] ?? null
  return figures
}

/**
 * Rejects a weight key that is not a similarity metric.
 *
 * The type system already prevents this at compile time; this holds the same line
 * at runtime, where weights arrive from localStorage and a hand-edited value could
 * name any key. A smuggled key is ignored rather than crashing — the reader's
 * stored weights survive, and the metric simply does not participate.
 */
export function isSimilarityMetric(key: string): key is SimilarityMetric {
  return (SIMILARITY_METRICS as readonly string[]).includes(key)
}
