import type { BriefingFigure } from '../../core/ai/briefing'
import { isKnownFigureKey } from '../../core/ai/intent-schema'
import { rowToMetrics, type AreaRow } from '../../core/plugins/acs'
import type { MetricValue } from '../../core/types'
import type { FigureInput } from './FigureCard'

/** Keep provider context to figures in the closed Explain allowlist. */
export function figureInputFromMetric(
  metric: MetricValue,
  geographies: readonly string[] = [],
  label?: string,
): FigureInput | null {
  if (!isKnownFigureKey(metric.key)) return null
  return {
    key: metric.key,
    value: metric.value,
    marginOfError: metric.quality.marginOfError,
    suppressed: metric.quality.suppressed,
    geographies,
    label,
    source: metric.source.citation ?? metric.source.dataset,
    publisher: metric.source.publisher,
    dataset: metric.source.dataset,
    table: metric.source.tableId,
    vintage: metric.source.vintage,
    derivation: metric.quality.derivation,
  }
}

export function figureInputsFromMetrics(
  metrics: readonly MetricValue[],
  geographies: readonly string[] = [],
  label?: string,
): FigureInput[] {
  return metrics.flatMap((metric) => {
    const figure = figureInputFromMetric(metric, geographies, label)
    return figure ? [figure] : []
  })
}

/**
 * The place-index display label for a ZIP code ("Corbin, KY"), or null
 * when the index has no entry for it — the same resolver shape the
 * sweep table's placeLabel prop and the CSV export already use.
 */
export type PlaceLabelResolver = (zip: string) => string | null

export function figureInputsFromAreaRow(
  row: AreaRow,
  keys?: readonly string[],
  placeLabel?: PlaceLabelResolver,
): FigureInput[] {
  const allowed = keys ? new Set(keys) : null
  // The display label, never the row's own name when a label exists:
  // production rows carry the ACS NAME label ("ZCTA5 40771") as their
  // name, and that label form is what used to reach the Explain
  // provider context here — as the matching geographies and as the
  // absence of a figure label the prose can attribute by place name.
  // The join mirrors the Answer Layer's withPlaceDisplayNames
  // (db73515): the index label wins, a ZCTA with no index entry falls
  // back to the name the row arrived with, and the row is not mutated.
  const displayLabel = placeLabel?.(row.zcta) ?? undefined
  return figureInputsFromMetrics(
    rowToMetrics(row).filter((metric) => !allowed || allowed.has(metric.key)),
    [row.zcta, displayLabel ?? row.name],
    displayLabel,
  )
}

/**
 * Pack figures keep the full SourceRef (unlike FigureInput, which
 * flattens it for display) because pack generation re-verifies every
 * figure against that ref.
 */
export function briefingFigureFromMetric(
  metric: MetricValue,
  geography: string,
  label?: string,
): BriefingFigure | null {
  if (!isKnownFigureKey(metric.key)) return null
  return {
    key: metric.key,
    geography,
    label,
    value: metric.value,
    marginOfError: metric.quality.marginOfError,
    suppressed: metric.quality.suppressed,
    source: metric.source,
  }
}

export function briefingFiguresFromMetrics(
  metrics: readonly MetricValue[],
  geography: string,
  label?: string,
): BriefingFigure[] {
  return metrics.flatMap((metric) => {
    const figure = briefingFigureFromMetric(metric, geography, label)
    return figure ? [figure] : []
  })
}

export function figureInputsFromAreaRows(
  rows: readonly AreaRow[],
  zctas: readonly string[],
  keys?: readonly string[],
  placeLabel?: PlaceLabelResolver,
): FigureInput[] {
  const selected = new Set(zctas)
  return rows.flatMap((row) =>
    selected.has(row.zcta) ? figureInputsFromAreaRow(row, keys, placeLabel) : [],
  )
}
