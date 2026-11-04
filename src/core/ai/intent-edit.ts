/**
 * Pure intent-edit helpers for the Ask surface. Every edit is revalidated
 * against the closed intent schema, so chips cannot widen the allowlist.
 */
import {
  DISPLAYABLE_KEYS,
  canRun,
  isDisplayOnlyDemographicKey,
  isFilterLegal,
  isRankLegal,
  validateIntent,
  withRunnability,
} from './intent-schema'
import { nationalScreenIntent } from './national-screen'
import { isRegionGeography } from './area-mention'
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
  const next = { ...intent, filters: [...intent.filters, filter] }
  // Same contract as the other edits: restamp via the single owner so adding
  // the resolving filter clears a sweep out of clarification.
  return checked(withRunnability(next))
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
  const filters = intent.filters.filter(
    (f) =>
      !(
        f.metricKey === filter.metricKey &&
        f.op === filter.op &&
        f.value === filter.value
      ),
  )
  const next = { ...intent, filters }
  // Same contract as the other removals: restamp via the single owner.
  // Dropping the last filter leaves a sweep runnable on its measure
  // alone — placeless as the national screen, placed as the
  // geography-bounded screen (2026-11-02).
  return checked(withRunnability(next))
}

/**
 * The clarification seam's reading of a merged measure set that
 * carries a display-only demographic figure (FM-9 live cure,
 * 2026-11-03: the ef1f266 gates read rank-legal, but this seam still
 * read the pre-ruling filter-legal surface, so a median-age pick
 * dead-ended here and a poverty pick never reached the degrade).
 * Two completions, mirroring the accept seam's degrade contract:
 *  - 'handoff': the demographic figure is the only measure and no
 *    Census bound is in play — the picks complete as the
 *    research-first handoff state (the key leaves the measure list;
 *    the question is served research-first, never figure-ranked).
 *    Ranking modes only: a placed lookup/compare completes on the
 *    figure itself, which is a display, not a ranking, and keeps
 *    its ordinary path.
 *  - 'screen': beside a rank-legal measure in a sweep/similarity,
 *    the demographic key is stripped and the screen proceeds on
 *    its remaining measures — the same degrade the accept seam
 *    applies to a blocked parse.
 * Anything else (a bound in play, a non-rank measure beside the
 * demographic key in a ranking mode) keeps the refusal.
 */
type DemographicResolution =
  | { kind: 'handoff' }
  | { kind: 'screen'; metricKeys: string[] }
  | null

function demographicResolution(picks: {
  mode: IntentMode
  geographies: string[]
  metricKeys: string[]
  filters: ValidatedIntent['filters']
}): DemographicResolution {
  const { mode, geographies, metricKeys, filters } = picks
  if (!metricKeys.some((key) => isDisplayOnlyDemographicKey(key))) return null
  const remaining = metricKeys.filter((key) => !isDisplayOnlyDemographicKey(key))
  if (remaining.length === 0) {
    if (filters.length > 0) return null
    if (mode === 'sweep_filter') return { kind: 'handoff' }
    if (mode === 'lookup' && geographies.length === 0) return { kind: 'handoff' }
    return null
  }
  if (
    (mode === 'sweep_filter' || mode === 'similarity') &&
    remaining.every((key) => isRankLegal(key))
  ) {
    return { kind: 'screen', metricKeys: remaining }
  }
  if (
    geographies.length === 0 &&
    filters.length === 0 &&
    remaining.some((key) => isRankLegal(key))
  ) {
    return { kind: 'screen', metricKeys: remaining }
  }
  return null
}

/**
 * Whether clarification picks complete the intent. Delegates to the one
 * predicate, so the resolve button and the Run gate can never disagree.
 * Callers pass the clarification picks merged with the existing intent.
 * One completion is not canRun's: with no place named or picked and no
 * bound in play, a rank-legal measure completes as the national
 * screen (national-screen.ts) — the placeless question's forward path.
 * (FM-9, owner ruling 2026-11-03: the screen's measures are the
 * RANK-legal surface, not only the filter-legal one — median_age
 * completes here exactly as median_gross_rent does; it still can
 * never appear in a filter.) An intent that names a place, even an
 * unresolvable one, never completes this way: its place must be
 * resolved, not bypassed. A display-only demographic pick completes
 * per demographicResolution above.
 */
export function canResolveClarification(picks: {
  mode: IntentMode
  geographies: string[]
  metricKeys?: string[]
  filters?: ValidatedIntent['filters']
}): boolean {
  const metricKeys = picks.metricKeys ?? []
  const filters = picks.filters ?? []
  const demographic = demographicResolution({
    mode: picks.mode,
    geographies: picks.geographies,
    metricKeys,
    filters,
  })
  if (demographic?.kind === 'handoff') return true
  const effectiveMetricKeys = demographic?.kind === 'screen' ? demographic.metricKeys : metricKeys
  if (
    picks.geographies.length === 0 &&
    filters.length === 0 &&
    effectiveMetricKeys.some((key) => isRankLegal(key))
  ) {
    return true
  }
  return canRun({
    mode: picks.mode,
    geographies: picks.geographies,
    metricKeys: effectiveMetricKeys,
    filters,
    clarificationNeeded: false,
  })
}

/**
 * Merge clarification picks into the intent and clear the clarification
 * flag. Unresolvable picks stay unresolved; the rest are revalidated.
 * Placeless picks with a rank-legal measure and no bound resolve to
 * the national screen instead of merging into the original mode: the
 * screen is the completion the question asked for, and the mode change
 * is visible in the understood request before anything runs. A
 * display-only demographic pick resolves per demographicResolution:
 * stripped beside a rank-legal screen measure, or — as the only
 * measure — the research-first handoff state, which is returned
 * unstamped by validateIntent for the same reason AskPanel's
 * researchFirstHandoff produces it directly: it is a marker state
 * for the answer layer, not an executable intent.
 */
export function resolveClarification(
  intent: ValidatedIntent,
  picks: { geographies: string[]; metricKeys: string[] },
): IntentEditResult {
  const geographies = [...new Set([...intent.geographies, ...picks.geographies])].slice(0, 8)
  const mergedMetricKeys = [...new Set([...intent.metricKeys, ...picks.metricKeys])]
  const demographic = demographicResolution({
    mode: intent.mode,
    geographies,
    metricKeys: mergedMetricKeys,
    filters: intent.filters,
  })
  if (demographic?.kind === 'handoff') {
    return {
      ok: true,
      intent: { ...intent, geographies, metricKeys: [], clarificationNeeded: false },
    }
  }
  const metricKeys = demographic?.kind === 'screen' ? demographic.metricKeys : mergedMetricKeys
  // Confirmed region (named-area cure, 2026-11-04): a region
  // geography the reader confirmed in the panel's area sync is a
  // screen scope, never a lookup target — the region is a set of
  // places to screen, and the runner resolves its membership
  // (core/ai/area-mention.ts, resolveAnswerGeographies). The merged
  // picks complete as a sweep over the named geographies, on the
  // same posture as the placeless completion below: the completion
  // the question asked for, visible in the understood request
  // before anything runs.
  if (geographies.some((g) => isRegionGeography(g))) {
    const next = { ...intent, mode: 'sweep_filter' as IntentMode, geographies, metricKeys }
    if (
      !canResolveClarification({
        mode: 'sweep_filter',
        geographies,
        metricKeys,
        filters: intent.filters,
      })
    ) {
      return { ok: false, error: 'clarification_required' }
    }
    return checked(withRunnability(next))
  }
  if (geographies.length === 0 && intent.filters.length === 0) {
    const screenKey = metricKeys.find((key) => isRankLegal(key))
    if (screenKey !== undefined) return checked(nationalScreenIntent(screenKey))
    return { ok: false, error: 'clarification_required' }
  }
  if (geographies.length === 0 || metricKeys.length === 0) {
    return { ok: false, error: 'clarification_required' }
  }
  const next = { ...intent, geographies, metricKeys }
  // The resolvable boolean is owned by the one predicate; this keeps only
  // the error mapping.
  if (!canResolveClarification({ mode: intent.mode, geographies, metricKeys, filters: next.filters })) {
    return { ok: false, error: 'clarification_required' }
  }
  return checked(withRunnability(next))
}
