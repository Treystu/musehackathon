/**
 * County aggregation over ZIP-area (ZCTA) rows, under the rules the
 * Jev-gated county semantics fixed (2026-11-02; see the COUNTY
 * FINDING history in src/core/ai/answer.ts):
 *
 *   - Assignment: one county per ZCTA by largest land overlap, from
 *     the shipped crosswalk (src/core/zcta-county-index.ts). A row
 *     whose ZCTA has no assignment is never guessed into a county;
 *     it is reported in `unassignedZctas`.
 *   - Counts are summed across member ZCTAs. The margin of a sum is
 *     the root-sum-of-squares of the member margins — the Census
 *     Bureau's own propagation for a sum of independent estimates.
 *   - Rates, means and medians are population-weighted means of the
 *     member values. The weight that exists on every swept row is
 *     the member row's `population` figure: SCREEN_VARS in
 *     src/core/plugins/acs.ts fetches B01003_001E for the whole
 *     screen, so every row the Answer Layer screens carries it.
 *     (A weighted mean of published medians is not the county's
 *     published median; it is the defensible aggregate of what the
 *     ZCTA data carries, and it is labelled as this app's aggregate
 *     wherever it is described.) The margin of a weighted mean is
 *     reported as the population-weighted root-mean-square of the
 *     member margins AND labelled an approximation — the flag rides
 *     on the aggregate (`approximateMarginKeys`) into the answer's
 *     figures, so the label survives to the card.
 *   - Anything else is not measurable at county level, never
 *     invented: an unknown metric key, a count with a member value
 *     missing (a partial sum would understate the county and read
 *     as a real total), or a weighted figure with no member carrying
 *     both a value and a population weight. Each such case is
 *     recorded in `notMeasurable` with its reason.
 *
 * The classification is by key, from the metric registry's own
 * definitions (src/core/plugins/acs.ts METRIC_DEFS): the nine count
 * keys sum; the six rate/mean/median keys weight. `median_age` sits
 * in the registry with unit 'count' because its unit is years — it
 * is a published median (B01002_001E) and is weighted here, never
 * summed; summing member median ages would be a number with no
 * meaning at all. The registry test in county-aggregate.test.ts pins
 * this classification against METRIC_KEYS so a future metric cannot
 * silently fall into the wrong rule — an unclassified key fails
 * closed as not aggregable until it is classified here.
 */
import type { AreaRow } from './plugins/acs'
import type { CountyAssignment } from './zcta-county-index'

export type { CountyAssignment }

/** Metric keys whose county figure is the sum of member figures. */
export const COUNT_METRIC_KEYS: ReadonlySet<string> = new Set([
  'households',
  'population',
  'renter_occupied',
  'owner_occupied',
  'vacant_units',
  'no_internet_access',
  'below_poverty_count',
  'bachelors_count',
  'commuting_workers',
])

/** Metric keys whose county figure is a population-weighted mean of member figures. */
export const WEIGHTED_METRIC_KEYS: ReadonlySet<string> = new Set([
  'median_gross_rent',
  'median_rent_burden_pct',
  'median_home_value',
  'median_household_income',
  'average_household_size',
  'median_age',
])

/** The metric key that carries the aggregation weight on every swept row. */
export const WEIGHT_METRIC_KEY = 'population'

export type MetricAggregationKind = 'count' | 'weighted' | 'not_aggregable'

export function classifyMetricKey(key: string): MetricAggregationKind {
  if (COUNT_METRIC_KEYS.has(key)) return 'count'
  if (WEIGHTED_METRIC_KEYS.has(key)) return 'weighted'
  return 'not_aggregable'
}

export type NotMeasurableReason =
  | 'not_aggregable'
  | 'partial_member_values'
  | 'no_member_value'
  | 'no_population_weight'
  | 'partial_weight_coverage'

export interface NotMeasurableFigure {
  /** County display name, e.g. `Boulder County, CO`. */
  county: string
  metricKey: string
  reason: NotMeasurableReason
}

/**
 * One county's aggregate, shaped as an AreaRow so the Answer Layer's
 * compose/verify stages consume it exactly like a screened row: the
 * figures are the row's metrics, copied by compose and checked by
 * verify against this same row.
 *
 * `zcta` carries the county key (`county:CO:Boulder County`) — a
 * synthetic identifier, never a real ZCTA, so a county aggregate can
 * never be mistaken for one of its members downstream. The display
 * name is `name` (`Boulder County, CO`).
 */
export interface CountyAggregateRow extends AreaRow {
  countyName: string
  state: string
  memberZctas: string[]
  /** Metric keys whose margin on this row is the RMS approximation. */
  approximateMarginKeys: string[]
}

export interface CountyAggregation {
  rows: CountyAggregateRow[]
  /** ZCTAs of input rows with no county assignment, in input order. */
  unassignedZctas: string[]
  notMeasurable: NotMeasurableFigure[]
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Aggregates rows to their assigned counties for the given metric
 * keys. County order is deterministic: by display name, then state —
 * ranking is the caller's job (the Answer Layer re-sorts by the
 * question's measure), and an aggregation that arrived pre-ranked
 * would hide which order was whose.
 */
export function aggregateRowsToCounties(
  rows: readonly AreaRow[],
  assignments: ReadonlyMap<string, CountyAssignment>,
  metricKeys: readonly string[],
): CountyAggregation {
  const membersByCounty = new Map<string, { assignment: CountyAssignment; members: AreaRow[] }>()
  const unassignedZctas: string[] = []
  for (const row of rows) {
    const assignment = assignments.get(row.zcta)
    if (!assignment) {
      unassignedZctas.push(row.zcta)
      continue
    }
    const key = `${assignment.name}|${assignment.state}`
    let group = membersByCounty.get(key)
    if (!group) {
      group = { assignment, members: [] }
      membersByCounty.set(key, group)
    }
    group.members.push(row)
  }

  const aggregates: CountyAggregateRow[] = []
  const notMeasurable: NotMeasurableFigure[] = []

  for (const { assignment, members } of membersByCounty.values()) {
    const displayName = `${assignment.name}, ${assignment.state}`
    const metrics: Record<string, number | null> = {}
    const moes: Record<string, number | null> = {}
    const approximateMarginKeys: string[] = []

    for (const key of metricKeys) {
      const kind = classifyMetricKey(key)
      if (kind === 'not_aggregable') {
        metrics[key] = null
        notMeasurable.push({ county: displayName, metricKey: key, reason: 'not_aggregable' })
        continue
      }
      if (kind === 'count') {
        // A sum is honest only when every member contributes: one
        // missing member value would make the total an undercount
        // wearing a total's clothes.
        if (members.some((m) => !finite(m.metrics[key]))) {
          metrics[key] = null
          notMeasurable.push({
            county: displayName,
            metricKey: key,
            reason: members.every((m) => !finite(m.metrics[key]))
              ? 'no_member_value'
              : 'partial_member_values',
          })
          continue
        }
        metrics[key] = members.reduce((sum, m) => sum + (m.metrics[key] as number), 0)
        // The RSS margin likewise needs every member margin; a
        // partial RSS would understate the uncertainty, so a missing
        // member margin leaves the sum's margin unreported instead.
        if (members.every((m) => finite(m.moes[key]))) {
          moes[key] = Math.sqrt(
            members.reduce((sum, m) => sum + (m.moes[key] as number) ** 2, 0),
          )
        }
        continue
      }
      // Weighted: members carrying both the value and a population
      // weight. A member with a value but no weight cannot be placed
      // in the mean without inventing its share of the county.
      const weighted = members.filter(
        (m) => finite(m.metrics[key]) && finite(m.metrics[WEIGHT_METRIC_KEY]) && (m.metrics[WEIGHT_METRIC_KEY] as number) > 0,
      )
      if (weighted.length === 0) {
        metrics[key] = null
        notMeasurable.push({
          county: displayName,
          metricKey: key,
          reason: members.some((m) => finite(m.metrics[key]))
            ? 'no_population_weight'
            : 'no_member_value',
        })
        continue
      }
      if (weighted.length < members.filter((m) => finite(m.metrics[key])).length) {
        notMeasurable.push({ county: displayName, metricKey: key, reason: 'partial_weight_coverage' })
      }
      const totalWeight = weighted.reduce((sum, m) => sum + (m.metrics[WEIGHT_METRIC_KEY] as number), 0)
      metrics[key] = weighted.reduce(
        (sum, m) => sum + (m.metrics[key] as number) * (m.metrics[WEIGHT_METRIC_KEY] as number),
        0,
      ) / totalWeight
      // Population-weighted RMS of the member margins, over the
      // members that carry one (weights renormalised over those
      // members). Labelled an approximation on the row: the member
      // margins describe ZCTA-level sampling error, and their
      // combination is a stated approximation of the county figure's
      // uncertainty, not an official Census county margin.
      const withMargins = weighted.filter((m) => finite(m.moes[key]))
      if (withMargins.length > 0) {
        const marginWeight = withMargins.reduce(
          (sum, m) => sum + (m.metrics[WEIGHT_METRIC_KEY] as number),
          0,
        )
        moes[key] = Math.sqrt(
          withMargins.reduce(
            (sum, m) => sum + (m.metrics[WEIGHT_METRIC_KEY] as number) * (m.moes[key] as number) ** 2,
            0,
          ) / marginWeight,
        )
        approximateMarginKeys.push(key)
      }
    }

    aggregates.push({
      zcta: `county:${assignment.state}:${assignment.name}`,
      name: displayName,
      metrics,
      moes,
      countyName: assignment.name,
      state: assignment.state,
      memberZctas: members.map((m) => m.zcta),
      approximateMarginKeys,
    })
  }

  aggregates.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.state.localeCompare(b.state, 'en'),
  )
  return { rows: aggregates, unassignedZctas, notMeasurable }
}
