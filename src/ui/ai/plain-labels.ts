/**
 * Plain-language labels for the Ask surface's internal identifiers.
 *
 * Owner live finding F-B (2026-11-02, battery findings register): the
 * clarification surface rendered the literal mode string
 * "sweep_filter" and all 15 measure keys (median_gross_rent,
 * median_age, ...) as button and option labels. Internal keys are
 * identifiers for code, not words for a reader, so every surface that
 * renders a mode or a measure goes through this module: the value a
 * control carries stays the key, the text a reader sees is the
 * registry's own label for it.
 *
 * The measure labels come from the same registry the intent allowlist
 * is derived from (core/civicscope-registry.ts), so a label here can
 * never drift from the label the data surfaces use. A key with no
 * registry entry falls back to itself — unreachable for a validated
 * intent, whose keys are allowlist-checked before they render.
 */
import { METRIC_DEFS_BY_KEY } from '../../core/civicscope-registry'
import type { IntentMode } from '../../core/ai/provider'

/** The reader-facing name of a measure key, e.g. "Median gross rent". */
export function measureLabel(key: string): string {
  return METRIC_DEFS_BY_KEY.get(key)?.label ?? key
}

const MODE_LABELS: Readonly<Record<IntentMode, string>> = {
  lookup: 'Look up a place',
  compare: 'Compare places',
  sweep_filter: 'Screen places',
  similarity: 'Find similar places',
}

/** The reader-facing name of an intent mode; never the raw mode string. */
export function modeLabel(mode: IntentMode): string {
  return MODE_LABELS[mode]
}

const FILTER_OP_LABELS: Readonly<Record<string, string>> = {
  gt: 'greater than',
  lt: 'less than',
  eq_range: 'equal to',
}

/** The reader-facing label for one intent filter, e.g. "Median gross rent greater than 2000". */
export function filterLabel(filter: { metricKey: string; op: string; value: number }): string {
  return `${measureLabel(filter.metricKey)} ${FILTER_OP_LABELS[filter.op] ?? filter.op} ${filter.value}`
}
