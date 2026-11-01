import { useState } from 'react'
import {
  canResolveClarification,
  resolveClarification,
} from '../../core/ai/intent-edit'
import type { ValidatedIntent } from '../../core/ai/provider'

export interface ClarificationCandidates {
  geographies: string[]
  metricKeys: string[]
}

const ERROR_COPY: Record<string, string> = {
  clarification_required: 'Choose at least one place and one measure before continuing.',
  not_allowlisted: 'That measure is not on the approved list.',
  shape_invalid: 'That choice is not valid.',
}

/** Candidate picker. Nothing executes until the clarification is resolved. */
export function ClarificationPanel({
  intent,
  candidates,
  onResolve,
}: {
  intent: ValidatedIntent
  candidates: ClarificationCandidates
  onResolve: (next: ValidatedIntent) => void
}) {
  const [geographies, setGeographies] = useState<string[]>([])
  const [metricKeys, setMetricKeys] = useState<string[]>([])
  const [error, setError] = useState('')

  const places = candidates.geographies.filter((g) => !intent.geographies.includes(g))
  const metrics = candidates.metricKeys.filter((k) => !intent.metricKeys.includes(k))
  // One answer: the button enables exactly when the merged picks would run.
  const canResolve = canResolveClarification({
    mode: intent.mode,
    geographies: [...intent.geographies, ...geographies],
    metricKeys: [...intent.metricKeys, ...metricKeys],
    filters: intent.filters,
  })

  function togglePlace(value: string) {
    setGeographies((current) =>
      current.includes(value) ? current.filter((x) => x !== value) : [...current, value],
    )
  }

  function toggleMetric(value: string) {
    setMetricKeys((current) =>
      current.includes(value) ? current.filter((x) => x !== value) : [...current, value],
    )
  }

  function resolve() {
    const result = resolveClarification(intent, { geographies, metricKeys })
    if (result.ok) {
      setError('')
      onResolve(result.intent)
      return
    }
    setError(ERROR_COPY[result.error] ?? 'That choice is not valid.')
  }

  return (
    <section aria-label="Clarify the request" className="mt-4">
      <p className="text-sm text-slate-700">Choose the place and measure before anything runs.</p>
      {places.length > 0 ? (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Places</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {places.map((place) => (
              <button
                key={place}
                type="button"
                aria-pressed={geographies.includes(place)}
                onClick={() => togglePlace(place)}
                className={
                  geographies.includes(place)
                    ? 'min-h-[44px] rounded-full border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                    : 'min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                }
              >
                {place}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-700">
          No candidate places were supplied. Add a place above, then use the current choices.
        </p>
      )}
      {metrics.length > 0 ? (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Measures</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {metrics.map((metric) => (
              <button
                key={metric}
                type="button"
                aria-pressed={metricKeys.includes(metric)}
                onClick={() => toggleMetric(metric)}
                className={
                  metricKeys.includes(metric)
                    ? 'min-h-[44px] rounded-full border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                    : 'min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                }
              >
                {metric}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" disabled={!canResolve} onClick={resolve} className="btn-primary mt-3">
        Use these choices
      </button>
      {error ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          {error}
        </p>
      ) : null}
    </section>
  )
}
