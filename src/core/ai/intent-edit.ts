/**
 * Pure intent-edit helpers for the Ask surface. Every edit is revalidated
 * against the closed intent schema, so chips cannot widen the allowlist.
 */
import { DISPLAYABLE_KEYS, isFilterLegal, validateIntent } from './intent-schema'
import type { ValidatedIntent } from './provider'

export type IntentFilter = ValidatedIntent['filters'][number]

export type IntentEditResult =
  | { ok: true; intent: ValidatedIntent }
  | { ok: false; error: string }

function checked(intent: ValidatedIntent): IntentEditResult {
  const result = validateIntent(intent)
  return result.ok
    ? { ok: true, intent: result.intent }
    : { ok: false, error: result.error }
}

export function addGeography(intent: ValidatedIntent, raw: string): IntentEditResult {
  const place = raw.trim()
  if (!place) return { ok: false, error: 'empty_geography' }
  if (intent.geographies.includes(place)) return { ok: true, intent }
  return checked({ ...intent, geographies: [...intent.geographies, place].slice(0, 8) })
}

export function addMetricKey(intent: ValidatedIntent, key: string): IntentEditResult {
  if (!(DISPLAYABLE_KEYS as readonly string[]).includes(key)) {
    return { ok: false, error: 'not_allowlisted' }
  }
  if (intent.metricKeys.includes(key)) return { ok: true, intent }
  return checked({ ...intent, metricKeys: [...intent.metricKeys, key] })
}

export function addFilter(intent: ValidatedIntent, filter: IntentFilter): IntentEditResult {
  if (!isFilterLegal(filter.metricKey)) return { ok: false, error: 'proxy_metric_blocked' }
  if (!['gt', 'lt', 'eq_range'].includes(filter.op)) {
    return { ok: false, error: 'shape_invalid' }
  }
  if (!Number.isFinite(filter.value)) return { ok: false, error: 'shape_invalid' }
  return checked({ ...intent, filters: [...intent.filters, filter] })
}

export function removeGeography(intent: ValidatedIntent, place: string): IntentEditResult {
  return checked({
    ...intent,
    geographies: intent.geographies.filter((g) => g !== place),
  })
}

export function removeMetricKey(intent: ValidatedIntent, key: string): IntentEditResult {
  return checked({
    ...intent,
    metricKeys: intent.metricKeys.filter((k) => k !== key),
  })
}

export function removeFilter(intent: ValidatedIntent, filter: IntentFilter): IntentEditResult {
  return checked({
    ...intent,
    filters: intent.filters.filter(
      (f) =>
        !(
          f.metricKey === filter.metricKey &&
          f.op === filter.op &&
          f.value === filter.value
        ),
    ),
  })
}

/** A clarification can resolve only when at least one place is selected. */
export function canResolveClarification(picks: { geographies: string[] }): boolean {
  return picks.geographies.length > 0
}

/**
 * Merge clarification picks into the intent and clear the clarification
 * flag. The merged intent is revalidated; a missing place stays unresolved.
 */
export function resolveClarification(
  intent: ValidatedIntent,
  picks: { geographies: string[]; metricKeys: string[] },
): IntentEditResult {
  const geographies = [...new Set([...intent.geographies, ...picks.geographies])].slice(0, 8)
  if (geographies.length === 0) return { ok: false, error: 'clarification_required' }
  const metricKeys = [...new Set([...intent.metricKeys, ...picks.metricKeys])]
  return checked({
    ...intent,
    geographies,
    metricKeys,
    clarificationNeeded: false,
  })
}
