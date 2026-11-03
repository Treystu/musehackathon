import { useState, type ReactNode } from 'react'
import type { ComposedAnswer } from '../../core/ai/answer'
import { sessionMapModel } from '../../core/map/session-map'
import { ResultMap } from './ResultMap'

/**
 * The Map tab (drive item 17 part c): the current session's results
 * map, in a full view.
 *
 * Before any question — and whenever the session's last answer named
 * no places — the tab is an inviting empty state, consistent with
 * the no-defaults ruling (surfaces start with no default areas): it
 * says what will appear here and where to get it, and draws nothing.
 * After a geographic answer, the tab is that answer's item-13 result
 * map (the shipped ResultMap machinery, unchanged) presented at the
 * tab's full width instead of the answer card's column, headed by
 * the question it answers and the metric that drives its colors —
 * both read from the session model (core/map/session-map.ts), which
 * is a pure function of the current answer, so a new answer replaces
 * this content outright.
 *
 * Item 18 S2 (surface-structure evaluation, 2026-11-02): the national
 * hex overview is demoted to a one-click link from this empty state.
 * The caller passes the overview surface in as `overview`; it is not
 * rendered — not even mounted — until the reader clicks "See the
 * whole country", and it never appears beside a session result, so
 * the tab's standing content stays the session's own map alone. The
 * overview itself is not deleted: one click still reaches the spatial
 * breadth picture, which is the value the evaluation measured for it.
 */
export function SessionMapView({
  answer,
  questionText,
  overview,
}: {
  answer: ComposedAnswer | null
  questionText: string | null
  overview?: ReactNode
}) {
  const [overviewShown, setOverviewShown] = useState(false)
  const model = sessionMapModel(answer)
  if (model.kind === 'empty' || !answer) {
    return (
      <section aria-label="Map of your results" className="mt-6">
        <h2 className="text-base font-medium text-slate-900">Map of your results</h2>
        <p className="mt-2 max-w-prose text-base text-slate-600">
          Ask a question and its map appears here. When an answer names places, this tab
          draws them on a map, colored by the figure the answer turns on.
        </p>
        {overview && !overviewShown && (
          <p className="mt-3">
            {/* py-1 (Lane completion K9): the DOM census on
                production 6027031 measured this button at 20px
                tall at every audited width — under the 24px
                tap-target floor, and a standalone button does
                not take the inline-link spacing exception. The
                vertical padding brings the box to ~28px; no other
                button shares this class string. */}
            <button
              type="button"
              onClick={() => setOverviewShown(true)}
              className="py-1 text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              See the whole country
            </button>
          </p>
        )}
        {overview && overviewShown && overview}
      </section>
    )
  }
  return (
    <section aria-label="Map of your results" className="mt-6">
      <h2 className="text-base font-medium text-slate-900">Map of your results</h2>
      {questionText && (
        <p className="mt-1 max-w-prose text-base text-slate-600">
          For the question: {questionText}
        </p>
      )}
      <p className="mt-1 text-sm text-slate-600">
        {model.placeCount} {model.placeCount === 1 ? 'place' : 'places'} from your last
        answer
        {model.drivingMetricLabel ? `, colored by ${model.drivingMetricLabel}` : ''}.
      </p>
      <ResultMap answer={answer} />
    </section>
  )
}
