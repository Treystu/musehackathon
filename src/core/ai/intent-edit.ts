/**
 * Pure intent-edit helpers for the Ask surface. Every edit is revalidated
 * against the closed intent schema, so chips cannot widen the allowlist.
 */
import {
  DISPLAYABLE_KEYS,
  canRun,
  isFilterLegal,
  validateIntent,
  withRunnability,
} from './intent-schema'
import type { IntentMode, ValidatedIntent } from './provider'

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
  // No-op adds still restamp: a duplicate chip must never hand back a stale flag.
  if (intent.geographies.includes(place)) return { ok: true, intent: withRunnability(intent) }
  const next = { ...intent, geographies: [...intent.geographies, place].slice(0, 8) }
  return checked(withRunnability(next))
}

export function addMetricKey(intent: ValidatedIntent, key: string): IntentEditResult {
  if (!(DISPLAYABLE_KEYS as readonly string[]).includes(key)) {
    return { ok: false, error: 'not_allowlisted' }
  }
  // No-op adds still restamp: a duplicate chip must never hand back a stale flag.
  if (intent.metricKeys.includes(key)) return { ok: true, intent: withRunnability(intent) }
  const next = { ...intent, metricKeys: [...intent.metricKeys, key] }
  return checked(withRunnability(next))
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
  return checked(withRunnability(next))
}

export function removeMetricKey(intent: ValidatedIntent, key: string): IntentEditResult {
  const metricKeys = intent.metricKeys.filter((k) => k !== key)
  const next = { ...intent, metricKeys }
  // Removing the last measure takes the intent back through clarification,
  // the same as removing the last place (canRun needs both).
  return checked(withRunnability(next))
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
 * Whether clarification picks complete the intent. Delegates to the one
 * predicate, so the resolve button and the Run gate can never disagree.
 * Callers pass the clarification picks merged with the existing intent.
 */
export function canResolveClarification(picks: {
  mode: IntentMode
  geographies: string[]
  metricKeys?: string[]
}): boolean {
  return canRun({
    mode: picks.mode,
    geographies: picks.geographies,
    metricKeys: picks.metricKeys ?? [],
    filters: [],
    clarificationNeeded: false,
  })
}

/**
 * Merge clarification picks into the intent and clear the clarification
 * flag. Unresolvable picks stay unresolved; the rest are revalidated.
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
  // The resolvable boolean is owned by the one predicate; this keeps only
  // the error mapping.
  if (!canResolveClarification({ mode: intent.mode, geographies, metricKeys })) {
    return { ok: false, error: 'clarification_required' }
  }
  return checked(withRunnability(next))
}
