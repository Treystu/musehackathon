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
 */
export function SessionMapView({
  answer,
  questionText,
}: {
  answer: ComposedAnswer | null
  questionText: string | null
}) {
  const model = sessionMapModel(answer)
  if (model.kind === 'empty' || !answer) {
    return (
      <section aria-label="Map of your results" className="mt-6">
        <h2 className="text-base font-medium text-slate-900">Map of your results</h2>
        <p className="mt-2 max-w-prose text-sm text-slate-600">
          Ask a question and its map appears here. When an answer names places, this tab
          draws them on a map, colored by the figure the answer turns on.
        </p>
      </section>
    )
  }
  return (
    <section aria-label="Map of your results" className="mt-6">
      <h2 className="text-base font-medium text-slate-900">Map of your results</h2>
      {questionText && (
        <p className="mt-1 max-w-prose text-sm text-slate-600">
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
