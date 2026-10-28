/**
 * Pure intent-edit helpers for the Ask surface. Every edit is revalidated
 * against the closed intent schema, so chips cannot widen the allowlist.
 */
import { DISPLAYABLE_KEYS, canRun, isFilterLegal, validateIntent } from './intent-schema'
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
  const geographies = intent.geographies.filter((g) => g !== place)
  const next = { ...intent, geographies }
  // The flag is derived from the one predicate: removal can only take a
  // runnable intent back through clarification, never clear the flag.
  return checked({ ...next, clarificationNeeded: !canRun(next) })
}

export function removeMetricKey(intent: ValidatedIntent, key: string): IntentEditResult {
  const metricKeys = intent.metricKeys.filter((k) => k !== key)
  const next = { ...intent, metricKeys }
  // Removing the last measure takes the intent back through clarification,
  // the same as removing the last place (canRun needs both).
  return checked({ ...next, clarificationNeeded: !canRun(next) })
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

/**
 * A clarification can resolve only when the picks carry the same
 * place/measure combination canRun needs: at least one place AND at
 * least one measure. Callers pass the clarification picks merged with the
 * existing intent so this answer agrees with canRun.
 */
export function canResolveClarification(picks: {
  geographies: string[]
  metricKeys?: string[]
}): boolean {
  return picks.geographies.length > 0 && (picks.metricKeys ?? []).length > 0
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
  const metricKeys = [...new Set([...intent.metricKeys, ...picks.metricKeys])]
  if (geographies.length === 0 || metricKeys.length === 0) {
    return { ok: false, error: 'clarification_required' }
  }
  const next = { ...intent, geographies, metricKeys }
  return checked({ ...next, clarificationNeeded: !canRun(next) })
}
