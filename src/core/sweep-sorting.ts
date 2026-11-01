import type { AreaRow } from './plugins/acs'
import type { SortableMetricKey } from './sortable-surface'

/**
 * Sort the national screen by an explicitly selected figure, or by ZIP code
 * when no figure is selected. Metric ties and missing values use ZIP order so
 * the displayed order is stable across reloads.
 */
export function sortSweepRows(
  rows: readonly AreaRow[],
  sortKey: SortableMetricKey | null,
  ascending = true,
): AreaRow[] {
  return [...rows].sort((a, b) => {
    if (sortKey === null) return a.zcta.localeCompare(b.zcta)

    const av = a.metrics[sortKey] ?? null
    const bv = b.metrics[sortKey] ?? null
    if (av === null && bv === null) return a.zcta.localeCompare(b.zcta)
    if (av === null) return 1
    if (bv === null) return -1
    if (av === bv) return a.zcta.localeCompare(b.zcta)
    return ascending ? av - bv : bv - av
  })
}
