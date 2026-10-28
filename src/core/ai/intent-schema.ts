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

const MODES: readonly IntentMode[] = [
  'lookup',
  'compare',
  'sweep_filter',
  'similarity',
]
const FILTER_OPS = ['gt', 'lt', 'eq_range'] as const
const MAX_GEOGRAPHIES = 8

/** Code-supplied derived figures are a closed set, not any `derived:` name. */
const KNOWN_DERIVED_FIGURE_KEYS = ['derived:renter_pct'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntentMode(value: unknown): value is IntentMode {
  return typeof value === 'string' && MODES.some((mode) => mode === value)
}

function isFilterOp(value: unknown): value is (typeof FILTER_OPS)[number] {
  return typeof value === 'string' && FILTER_OPS.some((op) => op === value)
}

export type SchemaError =
  | 'not_allowlisted'
  | 'shape_invalid'
  | 'proxy_metric_blocked'

export function isFilterLegal(key: string): key is FilterLegalKey {
  return FILTER_LEGAL_KEYS.some((legal) => legal === key)
}

export function isDisplayableKey(key: string): boolean {
  return DISPLAYABLE_KEYS.some((displayable) => displayable === key)
}

/** Known figure keys: registry keys plus the code-supplied derived set. */
export function isKnownFigureKey(key: string): boolean {
  return isDisplayableKey(key) || KNOWN_DERIVED_FIGURE_KEYS.some((known) => known === key)
}

/** Closed-world validation. Anything outside the declared shape fails. */
export function validateIntent(raw: unknown):
  | { ok: true; intent: ValidatedIntent }
  | { ok: false; error: SchemaError; detail: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'shape_invalid', detail: 'intent must be an object' }
  }
  if (!isIntentMode(raw.mode)) {
    return { ok: false, error: 'shape_invalid', detail: 'mode outside closed enum' }
  }
  if (!Array.isArray(raw.geographies)) {
    return { ok: false, error: 'shape_invalid', detail: 'geographies must be an array' }
  }
  if (!Array.isArray(raw.metricKeys)) {
    return { ok: false, error: 'shape_invalid', detail: 'metricKeys must be an array' }
  }
  if (!Array.isArray(raw.filters)) {
    return { ok: false, error: 'shape_invalid', detail: 'filters must be an array' }
  }
  if (typeof raw.clarificationNeeded !== 'boolean') {
    return { ok: false, error: 'shape_invalid', detail: 'clarificationNeeded must be a boolean' }
  }
  if (raw.geographies.length > MAX_GEOGRAPHIES) {
    return { ok: false, error: 'shape_invalid', detail: 'too many geographies' }
  }

  const geographies: string[] = []
  for (const g of raw.geographies) {
    if (typeof g !== 'string' || g.trim() === '') {
      return { ok: false, error: 'shape_invalid', detail: 'geography must be a non-empty string' }
    }
    geographies.push(g)
  }

  const metricKeys: string[] = []
  for (const k of raw.metricKeys) {
    if (typeof k !== 'string' || !isDisplayableKey(k)) {
      return { ok: false, error: 'not_allowlisted', detail: `metric key not in registry: ${String(k)}` }
    }
    metricKeys.push(k)
  }

  const filters: ValidatedIntent['filters'] = []
  for (const f of raw.filters) {
    if (!isRecord(f)) {
      return { ok: false, error: 'shape_invalid', detail: 'filter must be an object' }
    }
    if (Object.keys(f).some((key) => key !== 'metricKey' && key !== 'op' && key !== 'value')) {
      return { ok: false, error: 'shape_invalid', detail: 'filter has unknown fields' }
    }
    if (typeof f.metricKey !== 'string' || !isFilterLegal(f.metricKey)) {
      return {
        ok: false,
        error: 'proxy_metric_blocked',
        detail: `filter metric not filter-legal: ${String(f.metricKey)}`,
      }
    }
    if (!isFilterOp(f.op)) {
      return { ok: false, error: 'shape_invalid', detail: 'filter op outside closed enum' }
    }
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) {
      return { ok: false, error: 'shape_invalid', detail: 'filter value must be a finite number' }
    }
    filters.push({ metricKey: f.metricKey, op: f.op, value: f.value })
  }

  if (raw.mode === 'sweep_filter' || raw.mode === 'similarity') {
    for (const k of metricKeys) {
      if (!isFilterLegal(k)) {
        return {
          ok: false,
          error: 'proxy_metric_blocked',
          detail: `${raw.mode} cannot use non-filter-legal metric: ${k}`,
        }
      }
    }
  }

  return {
    ok: true,
    intent: {
      mode: raw.mode,
      geographies,
      metricKeys,
      filters,
      clarificationNeeded: raw.clarificationNeeded,
    },
  }
}
