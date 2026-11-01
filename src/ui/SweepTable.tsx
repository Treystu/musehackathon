/**
 * The country-wide screening table.
 *
 * This is the surface that makes a single request worth it: the entire country
 * is already in memory, so sorting and filtering are local operations with no
 * further requests and no quota cost. The user chooses what to sort by and can
 * put any number of areas into the comparison set.
 *
 * The initial order is ascending ZIP code. Readers can choose a single figure
 * to sort by; the order is not an overall place-quality judgment.
 *
 * The table is windowed rather than truncated. There are 33,791 rows, and the
 * earlier version drew the first 200 of whatever the current sort produced and
 * silently hid the other 33,591 — which meant a visitor who sorted by median
 * home value ascending saw the least expensive corner of the country and had no
 * way to reach the rest. Only the visible window is in the DOM; the caption and
 * the row count state the true total, and a screen reader is told how many rows
 * the table holds in total rather than only how many are mounted.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import type { AreaRow } from '../core/plugins/acs'
import type { MuseProvider } from '../core/ai/provider'
import type { AbsentReason, MetricUnit } from '../core/types'
import { isSortableMetricKey, type SortableMetricKey } from '../core/sortable-surface'
import { downloadCsv, toCsv } from '../core/export'
import { absenceLabel, formatMetricNumber, isMetricDisplayable } from './metric-format'
import { ExplainAction } from './ai/ExplainAction'
import { figureInputsFromAreaRow } from './ai/figure-input'


/**
 * A row's height in pixels, used to size the window.
 *
 * Rows now measure 53px in the browser: the 44px Explain target sits beside the
 * two-line ZIP/place label, whose cell padding determines the remaining height.
 * The window is arithmetic on this number — the scroll offset divided by it gives
 * the first visible row — so understating it makes scrolling skip rows. Re-measure
 * this when the row contents or target sizes change; do not estimate from font size.
 */
const ROW_HEIGHT = 53
/** Rows rendered above and below the viewport, so a fast scroll shows nothing blank. */
const OVERSCAN = 8
/**
 * How many rows to render per screen height.
 *
 * 30 rather than 60, because the container is 560px tall and a row is now 53px:
 * 30 rows is about three screens of scroll, which is what the overscan
 * exists to cover.
 */
const WINDOW_SIZE = 30

/**
 * The sortable columns.
 *
 * `sort` is typed as `SortableMetricKey | null`, so a column whose sort key is
 * not on the allowlist in `src/core/sortable-surface.ts` is a compile error
 * rather than a silent addition. That allowlist exists because
 * `src/core/types.ts` promises a metric which proxies a protected
 * characteristic is "NEVER offered as a sort or filter control", and for most
 * of this repository's life nothing enforced that — it held only because nobody
 * had happened to add a demographic column. Recorded as issue #11.
 */
const COLUMNS = [
  { key: 'zcta', label: 'ZIP & location', sort: null },
  { key: 'median_rent_burden_pct', label: 'Rent burden', sort: 'median_rent_burden_pct' as SortableMetricKey },
  { key: 'median_gross_rent', label: 'Median rent', sort: 'median_gross_rent' as SortableMetricKey },
  { key: 'median_home_value', label: 'Home value', sort: 'median_home_value' as SortableMetricKey },
  { key: 'median_household_income', label: 'Median income', sort: 'median_household_income' as SortableMetricKey },
  { key: 'households', label: 'Households', sort: 'households' as SortableMetricKey },
] as const

// Every declared sort key must be on the allowlist. Runs at module load, so a
// column added with a key that is not sortable fails immediately rather than
// when a user first clicks the header.
for (const c of COLUMNS) {
  if (c.sort !== null && !isSortableMetricKey(c.sort)) {
    throw new Error(`SweepTable column "${c.label}" sorts by "${c.sort}", which is not on the sortable allowlist`)
  }
}

const UNIT_OF: Record<string, MetricUnit> = {
  median_rent_burden_pct: 'percent',
  median_gross_rent: 'usd_monthly',
  median_home_value: 'usd',
  median_household_income: 'usd',
  households: 'count',
  population: 'count',
}

/**
 * Formats a margin of error, or returns null when there is nothing to show.
 *
 * Separate from `fmt` on purpose. `fmt` is the display formatter and returns the
 * absent label for anything it will not vouch for, which is right for a figure
 * and wrong for a margin: a rent-burden margin is routinely larger than 100
 * points, so routing it through `fmt` produced a literal "+/- not yet imported"
 * beside a perfectly valid 9%. A margin is also not a currency or a percentage
 * in its own right, so it carries no unit suffix either.
 */
function fmtMargin(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  if (value === 0) return '0'
  return formatMetricNumber(Math.round(value), 'number', { sweepPrecision: true })
}

function fmt(value: number | null, unit: MetricUnit, reason?: AbsentReason): string {
  if (value === null) return reason ? absenceLabel(reason) : 'not yet imported'
  if (!isMetricDisplayable(value, unit)) return absenceLabel(reason ?? 'out-of-range')
  return formatMetricNumber(value, unit, { percentSuffix: false, sweepPrecision: true })
}
export function SweepTable({
  rows,
  onAdd,
  onSortChange,
  selectedZctas,
  sortKey,
  ascending,
  placeLabel,
  explainProvider,
}: {
  rows: AreaRow[]
  onAdd: (zcta: string) => void
  onSortChange: (sortKey: SortableMetricKey, ascending: boolean) => void
  selectedZctas: string[]
  sortKey: (typeof COLUMNS)[number]['sort']
  ascending: boolean
  /**
   * `"Austin, TX"` for a ZIP code, or null when the mapping is unavailable.
   *
   * Null is passed through and rendered as nothing rather than as a placeholder,
   * because the alternative is a column of dashes down 33,791 rows saying "not
   * yet imported" about a figure that is simply not part of the ACS row.
   */
  placeLabel?: (zip: string) => string | null
  explainProvider?: MuseProvider
  visibleCount?: number
  totalCount?: number
  onShowMore?: () => void
}) {
  const [filter, setFilter] = useState('')
  const [start, setStart] = useState(0)
  const scroller = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(() => {
    const f = filter.trim()
    if (!f) return rows
    return rows.filter((r) => r.zcta.startsWith(f) || r.name.toLowerCase().includes(f.toLowerCase()))
  }, [rows, filter])

  // Any change to which rows are shown has to return the reader to the top.
  // Keeping the old offset would leave them looking at row 20,000 of a
  // different ordering, which reads as the sort having done nothing.
  useEffect(() => {
    setStart(0)
    if (scroller.current) scroller.current.scrollTop = 0
  }, [sortKey, ascending, filter])

  // The window is derived from the scroll offset held in state, rather than
  // read from the node during render: reading `scrollTop` while rendering is
  // not reactive and would produce a window that disagrees with the scrollbar.
  const from = Math.max(0, start)
  const to = Math.min(visible.length, from + WINDOW_SIZE + OVERSCAN * 2)
  const window = visible.slice(from, to)

  function header(col: (typeof COLUMNS)[number]) {
    if (!col.sort) {
      return <th scope="col" aria-sort={sortKey === null ? 'ascending' : undefined} className="px-3 py-2 text-left text-[0.8125rem] font-semibold text-slate-700">{col.label}</th>
    }
    const active = sortKey === col.sort
    return (
      <th scope="col" className="px-3 py-2 text-right text-[0.8125rem] font-semibold text-slate-700" aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          onClick={() => {
            onSortChange(col.sort, active ? !ascending : true)
          }}
          className="inline-flex items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          {col.label}
          <span aria-hidden="true" className="text-slate-400">{active ? (ascending ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    )
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor="zip-filter" className="text-sm font-medium text-slate-800">
            Filter ZIP codes
          </label>
          <input
            id="zip-filter"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            placeholder="787"
            className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            onClick={() => downloadCsv(toCsv(visible, { placeLabel }))}
            aria-label={`Download ${formatMetricNumber(visible.length, 'count')} ZIP codes as CSV`}
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            Export CSV
          </button>
          <p className="text-xs text-slate-600">
            {formatMetricNumber(visible.length, 'count')} of {formatMetricNumber(rows.length, 'count')} ZIP codes shown. Select areas to compare
            them side by side.
          </p>
        </div>
      </div>

      {/*
        A scroll container of fixed height with a spacer of the full list height,
        and the window translated into place. The table element keeps real
        semantics, so a screen reader still reads a table with a header row and
        row headers; only the number of mounted rows is bounded.
      */}
      <div
        ref={scroller}
        onScroll={(e) => setStart(Math.floor((e.target as HTMLDivElement).scrollTop / ROW_HEIGHT) - OVERSCAN)}
        className="mt-3 max-h-[560px] overflow-auto panel"
      >
        <table className="w-full text-left text-sm">
          <caption className="px-3 py-2 text-left text-xs text-slate-600">
            US ZIP code tabulation areas, American Community Survey 5-year estimates. The table starts in
            ascending ZIP code order; figure columns can be sorted individually. It holds {formatMetricNumber(visible.length, 'count')}
            areas in total and is scrolled rather than truncated, so every ZIP code is reachable.
          </caption>
          <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 backdrop-blur">
            <tr>
              {COLUMNS.map((c) => header(c))}
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {/*
            `aria-rowcount` and the spacer rows give assistive technology the
            real size of the set, so "33,791 rows" is not silently reduced to
            "60 rows" by the windowing.
          */}
          <tbody aria-rowcount={visible.length}>
            {start > 0 ? (
              <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }}>
                <td colSpan={COLUMNS.length + 1} />
              </tr>
            ) : null}
            {window.map((r) => {
              const isSelected = selectedZctas.includes(r.zcta)
              return (
                <tr key={r.zcta} className="border-b border-slate-100 odd:bg-white even:bg-slate-50/40 hover:bg-blue-50/60" style={{ height: ROW_HEIGHT }}>
                  {/*
                    The city sits in the same cell as the ZIP code rather than in
                    a column of its own. A 33,791-row table already scrolls
                    sideways on a phone, and the two fields are read together every
                    time, so separating them doubles the width for no gain.
                  */}
                  <th scope="row" className="px-3 py-1.5 text-left text-[0.8125rem] font-medium text-slate-900">
                    <span className="block font-mono tabular-nums">{r.zcta}</span>
                    {placeLabel?.(r.zcta) && (
                      <span className="block text-[0.6875rem] font-normal not-italic text-slate-500">
                        {placeLabel(r.zcta)}
                      </span>
                    )}
                  </th>
                  {COLUMNS.filter((c) => c.sort).map((c) => {
                    const value = r.metrics[c.sort!] ?? null
                    const marginText = fmtMargin(r.moes?.[c.sort!] ?? null)
                    return (
                      <td key={c.key} className="px-3 py-1.5 text-right text-[0.8125rem] tabular-nums text-slate-700">
                        {fmt(
                          value,
                          UNIT_OF[c.sort!] ?? 'count',
                          r.absent?.[c.sort!] ?? (value !== null && value > 100 ? 'out-of-range' : undefined),
                        )}
                        {/*
                          The margin is rendered beside the figure rather than in
                          a separate column, because a survey estimate without
                          its precision attached is the thing this app exists to
                          avoid. It only appears when the publisher supplies one.
                        */}
                        {marginText !== null && value !== null ? (
                          <span
                            className="ml-1 text-[0.6875rem] tabular-nums text-slate-500"
                            title={`Margin of error plus or minus ${marginText}`}
                          >
                            &plusmn;{marginText}
                          </span>
                        ) : null}
                      </td>
                    )
                  })}
                  {/* Keep the 44px target inside the 46px measured virtual row; vertical padding here would make scrolling drift. */}
                  <td className="px-3 py-0 text-right">
                    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                      {explainProvider && (
                        <ExplainAction
                          title="this row's figures"
                          figureSetId="sweep"
                          figures={figureInputsFromAreaRow(r)}
                          provider={explainProvider}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => onAdd(r.zcta)}
                        disabled={isSelected}
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-700"
                      >
                        {isSelected ? 'Added' : 'Compare'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {to < visible.length ? (
              <tr aria-hidden="true" style={{ height: (visible.length - to) * ROW_HEIGHT }}>
                <td colSpan={COLUMNS.length + 1} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
