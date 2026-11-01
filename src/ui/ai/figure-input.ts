import type { BriefingFigure } from '../../core/ai/briefing'
import { isKnownFigureKey } from '../../core/ai/intent-schema'
import { rowToMetrics, type AreaRow } from '../../core/plugins/acs'
import type { MetricValue } from '../../core/types'
import type { FigureInput } from './FigureCard'

/** Keep provider context to figures in the closed Explain allowlist. */
export function figureInputFromMetric(
  metric: MetricValue,
  geographies: readonly string[] = [],
): FigureInput | null {
  if (!isKnownFigureKey(metric.key)) return null
  return {
    key: metric.key,
    value: metric.value,
    marginOfError: metric.quality.marginOfError,
    suppressed: metric.quality.suppressed,
    geographies,
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
): FigureInput[] {
  return metrics.flatMap((metric) => {
    const figure = figureInputFromMetric(metric, geographies)
    return figure ? [figure] : []
  })
}

export function figureInputsFromAreaRow(
  row: AreaRow,
  keys?: readonly string[],
): FigureInput[] {
  const allowed = keys ? new Set(keys) : null
  return figureInputsFromMetrics(
    rowToMetrics(row).filter((metric) => !allowed || allowed.has(metric.key)),
    [row.zcta, row.name],
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
): BriefingFigure | null {
  if (!isKnownFigureKey(metric.key)) return null
  return {
    key: metric.key,
    geography,
    value: metric.value,
    marginOfError: metric.quality.marginOfError,
    suppressed: metric.quality.suppressed,
    source: metric.source,
  }
}

export function briefingFiguresFromMetrics(
  metrics: readonly MetricValue[],
  geography: string,
): BriefingFigure[] {
  return metrics.flatMap((metric) => {
    const figure = briefingFigureFromMetric(metric, geography)
    return figure ? [figure] : []
  })
}

export function figureInputsFromAreaRows(
  rows: readonly AreaRow[],
  zctas: readonly string[],
  keys?: readonly string[],
): FigureInput[] {
  const selected = new Set(zctas)
  return rows.flatMap((row) =>
    selected.has(row.zcta) ? figureInputsFromAreaRow(row, keys) : [],
  )
}
