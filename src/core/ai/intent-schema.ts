/**
 * Intent allowlist, mirrored from the CivicScope audit at 3aa7e10.
 * Filter-legal keys are exactly the sortable surface; protected-class and
 * school/health keys can never appear in filters by construction.
 */
import type { IntentMode, ValidatedIntent } from './provider'

/** Exactly src/core/sortable-surface.ts SORTABLE_METRIC_KEYS at 3aa7e10. */
export const FILTER_LEGAL_KEYS = [
  'median_rent_burden_pct',
  'median_gross_rent',
  'median_home_value',
  'median_household_income',
  'households',
] as const

export type FilterLegalKey = (typeof FILTER_LEGAL_KEYS)[number]

/** Displayable ACS keys (lookup/compare context). Mirrors METRIC_DEFS keys. */
export const DISPLAYABLE_KEYS = [
  'median_gross_rent',
  'median_rent_burden_pct',
  'median_home_value',
  'median_household_income',
  'households',
  'population',
  'renter_occupied',
  'owner_occupied',
  'vacant_units',
  'no_internet_access',
  'average_household_size',
  'median_age',
  'below_poverty_count',
  'bachelors_count',
  'commuting_workers',
] as const

const MODES: readonly string[] = ['lookup', 'compare', 'sweep_filter', 'similarity']

export type SchemaError =
  | 'not_allowlisted'
  | 'shape_invalid'
  | 'proxy_metric_blocked'

export function isFilterLegal(key: string): key is FilterLegalKey {
  return (FILTER_LEGAL_KEYS as readonly string[]).includes(key)
}

/** Closed-world validation. Anything outside the sets fails. */
export function validateIntent(raw: unknown):
  | { ok: true; intent: ValidatedIntent }
  | { ok: false; error: SchemaError; detail: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'shape_invalid', detail: 'intent must be an object' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.mode !== 'string' || !MODES.includes(r.mode)) {
    return { ok: false, error: 'shape_invalid', detail: 'mode outside closed enum' }
  }
  const mode = r.mode as IntentMode
  const geographies = Array.isArray(r.geographies) ? r.geographies : []
  const metricKeys = Array.isArray(r.metricKeys) ? r.metricKeys : []
  const filters = Array.isArray(r.filters) ? r.filters : []

  for (const k of metricKeys) {
    if (typeof k !== 'string' || !(DISPLAYABLE_KEYS as readonly string[]).includes(k)) {
      return { ok: false, error: 'not_allowlisted', detail: `metric key not in registry: ${String(k)}` }
    }
  }
  for (const f of filters) {
    if (typeof f !== 'object' || f === null) {
      return { ok: false, error: 'shape_invalid', detail: 'filter must be an object' }
    }
    const fk = (f as Record<string, unknown>).metricKey
    if (typeof fk !== 'string' || !isFilterLegal(fk)) {
      return {
        ok: false,
        error: 'proxy_metric_blocked',
        detail: `filter metric not filter-legal: ${String(fk)}`,
      }
    }
  }
  if (mode === 'sweep_filter' || mode === 'similarity') {
    for (const k of metricKeys) {
      if (!isFilterLegal(k)) {
        return {
          ok: false,
          error: 'proxy_metric_blocked',
          detail: `${mode} cannot use non-filter-legal metric: ${k}`,
        }
      }
    }
  }
  return {
    ok: true,
    intent: {
      mode,
      geographies: geographies.filter((g): g is string => typeof g === 'string').slice(0, 8),
      metricKeys: metricKeys.filter((k): k is string => typeof k === 'string'),
      filters: filters as ValidatedIntent['filters'],
      clarificationNeeded: Boolean(r.clarificationNeeded),
    },
  }
}
