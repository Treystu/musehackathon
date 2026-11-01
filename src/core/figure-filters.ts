/**
 * Figure filters over the loaded screen.
 *
 * The plan for these (Phase 2A) originally proposed filtering by school grades
 * and a health score. That was removed before it shipped, and issue #5 records
 * the removal: no ZIP-level source exists for either, and a filter is steering
 * when the figure it acts on is a proxy for a protected class. What remains is
 * the housing core — rent, rent burden, home value, and household count.
 *
 * Every metric here is drawn from `src/core/sortable-surface.ts`, the same
 * allowlist the sort columns and any future ranking weights draw from. That is
 * not a convenience. A filter is one half of the surface
 * `src/core/types.ts` calls "the single most important rule in the codebase" —
 * metrics that proxy a protected characteristic must never be offered as a sort
 * *or filter* control — and for most of this repository's life that rule was
 * enforced nowhere. Drawing from the allowlist means a future contributor cannot
 * add a demographic filter without also adding it to the sortable surface, where
 * a test and a gate check will name the decision.
 *
 * This filters; it does not rank. A reader who sets a maximum rent gets every
 * area at or under it, in whatever order they were already viewing, and the
 * count beside the table says how many were kept. There is no "best match" and
 * nothing is scored.
 */
import type { AreaRow } from './plugins/acs'
import { SORTABLE_METRIC_KEYS } from './sortable-surface'

/** The direction a bound compares in. */
export type Bound = 'atMost' | 'atLeast'

export interface FigureFilter {
  /** Must be on the sortable allowlist; the type carries that constraint. */
  metric: (typeof SORTABLE_METRIC_KEYS)[number]
  bound: Bound
  /** The reader's number, in the metric's own unit. null means "not filtering". */
  value: number | null
}

/**
 * The four filters offered. Fixed rather than a free choice of metric, so the
 * surface a reader sees is the one that was reviewed.
 *
 * `households` rather than the plan's "population": the plan's word, but
 * population is display-only on this screen while household count is an
 * allowlisted measure of the same thing — whether anyone lives there — and using
 * it keeps the allowlist honest without reopening a fair-housing decision to add
 * a demographic-adjacent key.
 */
export const FIGURE_FILTERS: readonly FigureFilter[] = [
  { metric: 'median_gross_rent', bound: 'atMost', value: null },
  { metric: 'median_rent_burden_pct', bound: 'atMost', value: null },
  { metric: 'median_home_value', bound: 'atMost', value: null },
  { metric: 'households', bound: 'atLeast', value: null },
]

/**
 * Applies the filters.
 *
 * An area with no published value for an active filter is **excluded**, not kept.
 * The reader asked a question — "rents under $1,200" — and an area with no rent
 * figure is not an answer to it. That exclusion is not silent: the table already
 * states "N of M ZIP codes shown", so the reader can see the filter removed
 * things, and the filter panel itself says so. The opposite choice (keep
 * value-less rows) would put rows with no figure at the top of a filtered view,
 * which reads as the filter having matched them.
 */
export function applyFigureFilters(
  rows: readonly AreaRow[],
  filters: readonly { metric: string; bound: Bound; value: number | null }[],
): AreaRow[] {
  const active = filters.filter(
    (f): f is { metric: (typeof SORTABLE_METRIC_KEYS)[number]; bound: Bound; value: number } =>
      f.value !== null && Number.isFinite(f.value) && (SORTABLE_METRIC_KEYS as readonly string[]).includes(f.metric),
  )
  if (active.length === 0) return [...rows]
  return rows.filter((row) =>
    active.every((f) => {
      const v = row.metrics[f.metric]
      if (v === null || v === undefined) return false
      return f.bound === 'atMost' ? v <= f.value : v >= f.value
    }),
  )
}
