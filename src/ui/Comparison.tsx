import { formatMetricMargin, formatMetricValue, isMetricDisplayable } from './metric-format'
import { MetricCard } from './MetricCard'
import { CompositeCard } from './CompositeCard'
import type { DrillState } from '../core/useHousingQuery'
import { comparableMetricRows } from '../core/comparison'
import { MAX_EXPLAIN_VALUES, type MuseProvider } from '../core/ai/provider'
import { ExplainAction } from './ai/ExplainAction'
import { figureInputFromMetric, figureInputsFromMetrics } from './ai/figure-input'

/**
 * Side-by-side comparison of the areas the user selected.
 *
 * The point of this surface is that the user assembled it. There is no
 * recommended ordering, no "winner", and no composite that implies one place is
 * better than another — the figures are laid out so the user can read across
 * and decide for themselves.
 */
export function Comparison({
  drilldowns,
  onDeselect,
  placeLabel,
  explainProvider,
}: {
  drilldowns: Record<string, DrillState>
  onDeselect: (zcta: string) => void
  explainProvider?: MuseProvider
  /** `"Austin, TX"` for a ZIP code, or null when the mapping is unavailable. */
  placeLabel?: (zip: string) => string | null
}) {
  const entries = Object.values(drilldowns)
  if (entries.length === 0) return null
  const comparableRows = comparableMetricRows(entries)
  const rowsPerComparison = Math.max(1, Math.floor(MAX_EXPLAIN_VALUES / entries.length))
  const explainRows = comparableRows.slice(0, rowsPerComparison)
  const comparisonFigures = explainRows.flatMap((row) =>
    row.values.flatMap((metric, index) => {
      const area = entries[index]
      const figure = figureInputFromMetric(metric, area ? [area.zcta, area.label] : [])
      return figure ? [figure] : []
    }),
  )

  return (
    <section aria-labelledby="comparison-heading" className="mt-8">
      <h2 id="comparison-heading" className="section-title">
        Comparing {entries.length} {entries.length === 1 ? 'area' : 'areas'}
      </h2>

      {explainProvider && entries.length > 1 && (
        <div className="mt-2">
          {explainRows.length < comparableRows.length && (
            <p className="text-xs text-slate-600">
              This explanation uses the first {explainRows.length} shared figures so each selected area fits the
              24-value request limit.
            </p>
          )}
          <ExplainAction
            title="the shared figures"
            figureSetId="comparison"
            figures={comparisonFigures}
            provider={explainProvider}
          />
        </div>
      )}

      <div className="mt-3 space-y-4">
        {entries.length > 1 && comparableRows.length > 0 && (
          <section aria-labelledby="comparison-matrix-heading" className="panel panel-padded">
            <h3 id="comparison-matrix-heading" className="text-sm font-semibold text-slate-900">
              Compare shared figures side by side
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Only measures available for every selected area from the same publisher, table, and vintage appear
              here. Margins of error stay beside their estimates. The figures describe differences; they do not
              explain causes or recommend an area.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Published measures available for all selected areas from the same source, table, and vintage.
                </caption>
                <thead>
                  <tr className="border-b border-slate-300">
                    <th scope="col" className="py-2 pr-4 font-semibold text-slate-800">Figure</th>
                    {entries.map((d) => {
                      const where = placeLabel?.(d.zcta) ?? d.label ?? d.zcta
                      return (
                        <th key={d.zcta} scope="col" className="min-w-40 px-3 py-2 font-semibold text-slate-800">
                          <span className="font-mono">{d.zcta}</span>
                          <span className="ml-2 font-normal text-slate-600">{where}</span>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {comparableRows.map((row) => (
                    <tr key={row.key} className="border-b border-slate-200 align-top">
                      <th scope="row" className="max-w-64 py-3 pr-4 font-medium text-slate-800">
                        {row.label}
                        {row.note && <span className="mt-1 block text-xs font-normal text-slate-600">{row.note}</span>}
                      </th>
                      {row.values.map((metric, index) => {
                        const margin = metric.quality.marginOfError
                        return (
                          <td key={`${entries[index]!.zcta}-${row.key}`} className="px-3 py-3 tabular-nums text-slate-800">
                            {formatMetricValue(metric, metric.absentReason)}
                            {margin !== undefined && isMetricDisplayable(metric.value, metric.unit) && (
                              <span className="ml-1 text-xs font-normal text-slate-500">
                                ±{formatMetricMargin(margin, metric.unit)}
                              </span>
                            )}
                            {metric.geographyContext && (
                              <span className="mt-1 block text-xs font-normal text-slate-600">
                                <span className="font-medium">Geography: </span>{metric.geographyContext}
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {entries.map((d) => {
          /*
            The city is taken from the mapping rather than from `d.label`, which
            is `formatPlace(place)` and varies with how the area was selected — a
            ZIP typed into the box, a row in the sweep table, or a suggestion. Two
            areas in the same city would otherwise be headed differently, and
            "Austin city, Texas" from Photon is not the name the Census publishes.
           */
          const where = placeLabel?.(d.zcta) ?? null
          return (
          <article key={d.zcta} className="panel panel-padded">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  <span className="font-mono">{d.zcta}</span>
                  {where ? (
                    <span className="ml-2 font-normal text-slate-600">{where}</span>
                  ) : (
                    d.label && <span className="ml-2 font-normal text-slate-600">{d.label}</span>
                  )}
                </h3>
                {d.loading && (
                  <p className="mt-1 text-sm text-slate-600" role="status">
                    Fetching detail…
                  </p>
                )}
                {d.error && (
                  <p className="mt-1 text-sm text-red-800" role="alert">
                    {d.error}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDeselect(d.zcta)}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-700"
              >
                Remove
              </button>
            </div>

            {explainProvider && (
              <div className="mt-3">
                <ExplainAction
                  title="this area's figures"
                  figureSetId="drilldown"
                  figures={figureInputsFromMetrics(d.metrics, [d.zcta, d.label])}
                  provider={explainProvider}
                />
              </div>
            )}

            {d.composites.some((c) => c.score !== null) && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {d.composites.map((c) => (
                  <CompositeCard key={c.id} composite={c} />
                ))}
              </div>
            )}

            {d.metrics.length > 0 && (
              <>
                <h4 className="mt-5 text-sm font-semibold text-slate-900">Every figure, unmodified</h4>
                <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {d.metrics.map((m) => (
                    <MetricCard key={`${d.zcta}-${m.key}-${m.source.tableId}`} metric={m} />
                  ))}
                </div>
              </>
            )}

            {d.hasSchools && (
              <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-600">
                <span className="font-medium text-slate-700">About school data here:</span> district staffing
                and enrollment figures cover all 50 states. Near this location, the national source can show
                up to eight nearest public schools within 3 km with a reportable 2019 four-year graduation-rate
                midpoint; many records instead contain a published range, and missing or suppressed outcomes
                are omitted.
                NYC&rsquo;s separate DOE directory still supplies named-school enrollment, graduation and
                attendance figures from 2018–19. Neither source is a school-quality rating.
              </p>
            )}
          </article>
          )
        })}
      </div>
    </section>
  )
}
