/**
 * Every ZIP code inside one city, so a reader can pick a specific neighbourhood
 * rather than whichever one a search happened to return.
 *
 * Two behaviours here were decided rather than defaulted:
 *
 * The list is capped and says so. Austin has more ZIP codes than fit on a screen,
 * and a "show all" control that reveals 40 rows pushes the comparison it exists
 * to serve off the bottom. The cap states the true total rather than implying the
 * visible rows are all of them.
 *
 * The list is alphabetical by ZIP code, never by population or by any figure from
 * the data. Ordering it by "biggest first" would make this a ranking of
 * neighbourhoods, which is the one thing this app does not do; every ordering it
 * offers is one the reader chose.
 *
 * A county fallback is labelled as one. Where a ZIP code has no incorporated city
 * — 4,983 of the country's 33,791, measured — the mapping names its county, and
 * calling that a city would be a small lie in the one field a person uses to
 * decide whether the list applies to them.
 */
import { useState } from 'react'

import type { PlaceSuggestion } from '../core/zcta-place-index'

/** Rows shown before expanding. Chosen so the control stays above the fold. */
const COLLAPSED_ROWS = 8

export interface CityZipBrowserProps {
  place: PlaceSuggestion
  /** ZIP codes already in the comparison, so their buttons read as done. */
  selectedZctas: string[]
  onAdd: (zip: string) => void
  onDismiss: () => void
}

export function CityZipBrowser({ place, selectedZctas, onAdd, onDismiss }: CityZipBrowserProps) {
  const [expanded, setExpanded] = useState(false)
  const total = place.zips.length
  const shown = expanded ? place.zips : place.zips.slice(0, COLLAPSED_ROWS)
  const headingId = `city-zips-${place.displayName}-${place.state}`.replace(/\s+/g, '-')

  return (
    <section aria-labelledby={headingId} className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-slate-900">
          {place.displayName}, {place.state}
          {!place.isCity && <span className="ml-2 font-normal text-slate-600">county — no incorporated city</span>}
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-700"
        >
          Close
        </button>
      </div>

      <p className="mt-1 text-xs text-slate-600">
        {total} ZIP {total === 1 ? 'code' : 'codes'} in this {place.isCity ? 'city' : 'county'}. Choose one to add it
        to the comparison.
      </p>

      <ul className="mt-2 flex flex-wrap gap-2">
        {shown.map((zip) => {
          const added = selectedZctas.includes(zip)
          return (
            <li key={zip}>
              <button
                type="button"
                onClick={() => onAdd(zip)}
                disabled={added}
                aria-label={added ? `${zip} is already in the comparison` : `Add ZIP code ${zip} to the comparison`}
                className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
              >
                {added ? `${zip} added` : zip}
              </button>
            </li>
          )
        })}
      </ul>

      {/*
        The count is the true total, not the number rendered. A collapsible that
        says "8 ZIP codes" when there are 40 reads as though those are all of them,
        which is the same defect the screening table had when it truncated 33,791
        rows to 200.
      */}
      {total > COLLAPSED_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          {expanded ? 'Show fewer' : `Show all ${total} ZIP codes`}
        </button>
      )}
    </section>
  )
}
