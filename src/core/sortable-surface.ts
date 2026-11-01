/**
 * PRE-EXISTING (contest port, issue #33): the sortable surface in this file
 * (SORTABLE_METRIC_KEYS, 5 keys) is pre-existing CivicScope code, not
 * contest-built.
 * Source: Sovereign-Communication/civicscope at 3aa7e10dc59e764a8636aa273d4ff86714a3e782.
 * See docs/contest-port-manifest.md.
 */
/**
 * Which metrics may ever drive a sort, a filter or a ranking weight.
 *
 * `src/core/types.ts` defines the rule this module enforces:
 *
 * > True if the metric encodes or proxies a protected characteristic. Such
 * > metrics are displayed but are NEVER offered as a sort or filter control.
 * > This is the single most important rule in the codebase.
 *
 * For most of this repository's life that rule was a comment. `scoring.ts` said
 * "the engine refuses to fold demographic data into a composite. That is a hard
 * rule, not a convention" while `compute()` read no such flag, and no plugin set
 * it. The only thing keeping demographic figures out of the sort controls was
 * that nobody had happened to add one. Found while closing the gap before
 * building the Phase 2B ranking weights, which are exactly the surface the rule
 * exists to protect — recorded as issue #11.
 *
 * So the allowlist is positive and explicit. A metric key is sortable only if it
 * is listed here, and a key is listed here only if it comes from the ACS housing
 * plugin, which is not marked `protectedClassProxy`. Anything else — the CDC
 * PLACES health measures, the school plugins' figures, anything a future plugin
 * contributes — is refused by construction rather than by absence.
 *
 * Three consumers draw from this list and are pinned to it by
 * `tests/sortable-surface.test.ts`:
 *
 *   - the screening table's sortable columns (`SweepTable`)
 *   - the preset sorts on the explore view (`App`)
 *   - the Phase 2B similarity weights, when that feature ships
 *
 * If a key needs to become sortable, add it here and the test fails until the
 * plugin it comes from is confirmed not to be a protected-class proxy. That is
 * the point: the decision becomes a visible, reviewable line in a diff rather
 * than something that slips in through a column list.
 */
import { METRIC_DEFS_BY_KEY } from './plugins/acs'

/**
 * The housing figures a reader may sort the country by.
 *
 * Deliberately narrow. `median_household_income` is included with the Fair
 * Housing notice beside it, per the recorded decision that income is retained
 * with disclosure rather than excluded; it correlates with protected classes
 * without encoding one.
 *
 * Everything the ACS screen loads but this list omits — population, age, poverty
 * rate, educational attainment, broadband, crowding — is display-only. Several
 * of those are the demographic figures the rule exists to keep out of a ranking
 * control, and their absence here is the rule working.
 */
export const SORTABLE_METRIC_KEYS = [
  'median_rent_burden_pct',
  'median_gross_rent',
  'median_home_value',
  'median_household_income',
  'households',
] as const

export type SortableMetricKey = (typeof SORTABLE_METRIC_KEYS)[number]

/** Every allowlisted key must exist in the ACS housing definitions. */
export function isSortableMetricKey(key: string): key is SortableMetricKey {
  return (SORTABLE_METRIC_KEYS as readonly string[]).includes(key) && METRIC_DEFS_BY_KEY.has(key)
}
