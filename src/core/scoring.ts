/**
 * Scoring.
 *
 * Two design commitments, both load-bearing:
 *
 *  1. Composite indices are never shown without their components. The number is
 *     a convenience; the parts are the truth. Users who disagree with the
 *     weights can see exactly what moved the result.
 *
 *  2. A composite is built only from figures its source actually publishes.
 *     There was an education index here once — 60% per-pupil spending, 40%
 *     students per teacher — and it was removed on 2026-10-09, because the
 *     spending component had never been a spending figure: the NCES layer this
 *     app reads publishes no finance field, and the metric labelled
 *     "Expenditure per pupil" carried the district's teacher count. Normalized
 *     inside a per-pupil spending range that clamped it to zero everywhere in
 *     the country, every district scored exactly 40. An index with a fabricated
 *     input is worse than no index, so the index is gone. It can return when a
 *     real finance source is wired in — the Census school system finances
 *     survey — and its rules table will say so at that point.
 *
 * Scoring is only ever applied to metrics that are not marked
 * `protectedClassProxy`. The engine refuses to fold demographic data into a
 * composite. That is a hard rule, not a convention.
 */

import type { MetricValue } from './types'

export interface Component {
  key: string
  label: string
  /** 0-100, direction already normalized so higher is always better. */
  score: number
  /** The metric's raw value, for display beside the score. */
  raw: number | null
  unit: MetricValue['unit']
  weight: number
  /** Set when the component was excluded and why. */
  excluded?: string
}

export interface Composite {
  id: 'affordability' | 'education'
  label: string
  /** null when there was not enough data to compute honestly. */
  score: number | null
  components: Component[]
  /** Human-readable statement of what was included and excluded. */
  basis: string
}
/**
 * Percentile-style normalization without a population to compute against.
 *
 * We deliberately do NOT normalize against the full set of US areas, because
 * that would require holding a national dataset in the browser — which is the
 * thing this architecture exists to avoid. Instead each component is scaled
 * against documented reference bounds. The bounds are stated in the UI, and
 * they are the reason these indices are comparable within a query rather than
 * across unrelated ones.
 */
interface Rule {
  key: string
  label: string
  unit: MetricValue['unit']
  weight: number
  /** Numerically smaller end of the metric's plausible range. */
  floor: number
  /** Numerically larger end of the metric's plausible range. */
  ceiling: number
  betterWhen: 'higher' | 'lower'
  note: string
}

const AFFORDABILITY_RULES: Rule[] = [
  {
    key: 'median_rent_burden_pct',
    label: 'Median rent as share of income',
    unit: 'percent',
    weight: 0.4,
    floor: 15,
    ceiling: 45,
    betterWhen: 'lower',
    note: 'Share of gross income spent on rent. 30% is the conventional cost-burden threshold; 15% is unusually low and 45% is severe.',
  },
  {
    key: 'median_gross_rent',
    label: 'Median gross rent',
    unit: 'usd_monthly',
    weight: 0.25,
    floor: 700,
    ceiling: 3200,
    betterWhen: 'lower',
    note: 'Absolute rent level. This term does not account for income and is most meaningful next to the burden figure above.',
  },
  {
    key: 'median_home_value',
    label: 'Median home value',
    unit: 'usd',
    weight: 0.2,
    floor: 120000,
    ceiling: 900000,
    betterWhen: 'lower',
    note: 'Absolute home value level, for buyers. Scaled to the full observed range of US ZCTA medians.',
  },
  {
    key: 'median_household_income',
    label: 'Median household income',
    unit: 'usd',
    weight: 0.15,
    floor: 30000,
    ceiling: 140000,
    betterWhen: 'higher',
    note: 'Household income, a primary input to whether local prices are manageable.',
  },
]

// There is no education rules table here, on purpose. The one that lived at
// this spot until 2026-10-09 weighted "Expenditure per pupil" at 0.6, and that
// metric was the district's teacher count under a dollars label — the NCES
// layer publishes no finance field. Every district in the country therefore
// scored exactly 40 on the education index. The index is removed rather than
// reweighted, because a one-component composite is not a composite and a
// fabricated input is not a weight. See the header comment for the full story.

export const SCORE_VERSION = '1.1.0'

/**
 * Maps a raw metric onto 0-100.
 *
 * `floor` is the worse end of the range and `ceiling` the better end, so a
 * `lower is better` metric declares a lower `floor` (worse) and a higher
 * `ceiling` (better). Direction is then applied once, here, and only here.
 */
export function normalize(rule: Rule, raw: number): number {
  const { floor, ceiling, betterWhen } = rule
  const span = ceiling - floor
  if (span === 0) return 50
  const t = (raw - floor) / span
  const clamped = Math.max(0, Math.min(1, t))
  return betterWhen === 'higher' ? clamped * 100 : (1 - clamped) * 100
}

function compute(rules: Rule[], metrics: readonly MetricValue[]): Composite['score'] extends never ? never : Composite {
  const byKey = new Map(metrics.map((m) => [m.key, m]))
  const components: Component[] = []
  const refused: string[] = []

  for (const rule of rules) {
    const m = byKey.get(rule.key)
    // The hard rule, enforced here rather than promised in the header comment.
    // For most of this file's life this check did not exist: the comment below
    // said the engine "refuses to fold demographic data into a composite. That is
    // a hard rule, not a convention" while compute() read no flag, and no plugin
    // set one. Found as issue #11 and closed by making the refusal mechanical.
    if (m?.protectedClassProxy) {
      refused.push(rule.label)
      components.push({
        key: rule.key,
        label: rule.label,
        score: 0,
        raw: null,
        unit: rule.unit,
        weight: rule.weight,
        excluded: 'Excluded: this metric proxies a protected characteristic',
      })
      continue
    }
    if (!m || m.value === null) {
      components.push({
        key: rule.key,
        label: rule.label,
        score: 0,
        raw: null,
        unit: rule.unit,
        weight: rule.weight,
        excluded: m?.quality.suppressed ? 'Withheld by a suppression rule' : 'Not available for this area',
      })
      continue
    }
    components.push({
      key: rule.key,
      label: rule.label,
      score: normalize(rule, m.value),
      raw: m.value,
      unit: rule.unit,
      weight: rule.weight,
    })
  }

  // Renormalize across whatever is actually present. A composite computed from
  // two of four inputs is a different measurement than one computed from all
  // four, and the basis string has to say so rather than quietly implying
  // full coverage.
  const present = components.filter((c) => c.excluded === undefined)
  if (present.length === 0) {
    return { id: 'affordability', label: '', score: null, components, basis: 'No data available.' }
  }

  const totalWeight = present.reduce((s, c) => s + c.weight, 0)
  const score = present.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
  const missing = components.filter((c) => c.excluded !== undefined).map((c) => c.label)

  const basis =
    `Computed from ${present.length} of ${rules.length} published components` +
    (totalWeight < 0.999 ? ', reweighted to sum to 100% over the available components.' : '.') +
    (missing.length ? ` Not available: ${missing.join(', ')}.` : '') +
    (refused.length ? ` Excluded by the fair-housing rule: ${refused.join(', ')}.` : '')

  return {
    id: 'affordability',
    label: '',
    score: Math.round(score),
    components,
    basis,
  }
}

export function affordabilityIndex(metrics: readonly MetricValue[]): Composite {
  const c = compute(AFFORDABILITY_RULES, metrics)
  return { ...c, id: 'affordability', label: 'Affordability' }
}

/**
 * The one composite that remains. There was a second — education — removed on
 * 2026-10-09; see the header. scoreBoth keeps its name because it is what the
 * drilldown consumes, and the list is what changes, not every caller.
 */
export function scoreBoth(metrics: readonly MetricValue[]): Composite[] {
  return [affordabilityIndex(metrics)]
}

/** Exposed so the methodology page can render the rules without duplication. */
export const SCORE_RULES = {
  affordability: AFFORDABILITY_RULES,
  version: SCORE_VERSION,
} as const
