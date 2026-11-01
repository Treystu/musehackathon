import type { MetricValue } from './types'

export interface ComparableMetricRow {
  key: string
  label: string
  note?: string
  values: MetricValue[]
}

function sourceIdentity(metric: MetricValue): string {
  const { publisher, dataset, tableId, vintage } = metric.source
  return [publisher, dataset, tableId, vintage].join('\u0000')
}

/**
 * Select only figures that can be compared on the same published basis.
 *
 * A key can be populated by different publishers or geographies in different
 * areas (school data is the current example). Putting those values in one row
 * would look like a comparison while silently changing the measurement, so a
 * row appears only when every selected area has the same key, unit, publisher,
 * dataset, table, and vintage.
 */
export function comparableMetricRows(
  areas: readonly { metrics: readonly MetricValue[] }[],
): ComparableMetricRow[] {
  if (areas.length < 2) return []

  const seen = new Set<string>()
  const firstArea = areas[0]!
  const rows: ComparableMetricRow[] = []

  for (const first of firstArea.metrics) {
    if (seen.has(first.key)) continue
    seen.add(first.key)

    const values = [first]
    let comparable = true
    for (const area of areas.slice(1)) {
      const match = area.metrics.find((metric) => metric.key === first.key)
      if (
        !match ||
        match.unit !== first.unit ||
        match.label !== first.label ||
        sourceIdentity(match) !== sourceIdentity(first)
      ) {
        comparable = false
        break
      }
      values.push(match)
    }

    if (comparable) rows.push({ key: first.key, label: first.label, note: first.note, values })
  }

  return rows
}
