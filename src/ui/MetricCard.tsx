import { useId, useState } from 'react'
import type { MetricValue } from '../core/types'
import { formatMetricMargin, formatMetricValue, isMetricDisplayable } from './metric-format'

/**
 * Renders a figure, or states plainly that there is none.
 *
 * The same guard as the screening table: a value that is absent, non-finite, or
 * implausibly large is described rather than displayed. The Census Bureau encodes
 * an absent estimate as a large negative number, and showing that as a figure
 * would be a confident lie rather than a placeholder.
 */


/**
 * A single figure with its uncertainty and its provenance.
 *
 * Two rules are enforced structurally rather than by convention:
 *  - A margin of error is never hidden. If the source published one, it is
 *    rendered next to the value. Presenting a bare point estimate would
 *    misrepresent what survey data can support.
 *  - Every figure links to the exact table it came from, so any claim on this
 *    site can be independently re-fetched.
 */
export function MetricCard({ metric, notice }: { metric: MetricValue; notice?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const moe = metric.quality.marginOfError

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-slate-700">{metric.label}</h3>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
            {formatMetricValue(metric, metric.absentReason)}
            {moe !== undefined && isMetricDisplayable(metric.value, metric.unit) && (
              <span className="ml-1 text-sm font-normal text-slate-500">
                ±{formatMetricMargin(moe, metric.unit)}
              </span>
            )}
          </p>
        </div>
        {metric.quality.derived && (
          <span
            className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
            title="Calculated by us from published data, not a figure the publisher released."
          >
            computed
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="mt-2 text-xs text-slate-600 underline hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-600"
      >
        {open ? 'Hide detail' : 'Where this number comes from'}
      </button>

      {open && (
        <div id={panelId} className="mt-2 space-y-2 text-xs text-slate-600">
          {metric.geographyContext && (
            <p>
              <span className="font-medium">Geography: </span>
              {metric.geographyContext}
            </p>
          )}
          {metric.note && <p className="text-slate-700">{metric.note}</p>}
          {metric.quality.derivation && (
            <p>
              <span className="font-medium">How we computed it: </span>
              {metric.quality.derivation}
            </p>
          )}
          {moe !== undefined && (
            <p>
              <span className="font-medium">Margin of error: </span>±
              {formatMetricMargin(moe, metric.unit)} at the 90% confidence
              level, as published by {metric.source.publisher}.
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt className="font-medium">Source</dt>
            <dd>{metric.source.publisher}</dd>
            <dt className="font-medium">Dataset</dt>
            <dd>{metric.source.dataset}</dd>
            <dt className="font-medium">Table</dt>
            <dd className="font-mono">{metric.source.tableId}</dd>
            <dt className="font-medium">Vintage</dt>
            <dd>{metric.source.vintage}</dd>
          </dl>
          <a
            href={metric.source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block font-mono break-all underline hover:text-slate-900"
          >
            {metric.source.citation ?? 'Open the original query'}
          </a>
        </div>
      )}

      {notice && <p className="mt-2 border-t border-slate-200 pt-2 text-xs italic text-slate-500">{notice}</p>}
    </div>
  )
}
