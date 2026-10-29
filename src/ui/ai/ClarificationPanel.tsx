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
    <section aria-label="Clarify the request">
      <p>Choose the place and measure before anything runs.</p>
      {places.length > 0 ? (
        <div>
          <span>Places</span>
          {places.map((place) => (
            <button
              key={place}
              type="button"
              aria-pressed={geographies.includes(place)}
              onClick={() => togglePlace(place)}
            >
              {place}
            </button>
          ))}
        </div>
      ) : (
        <p>No candidate places were supplied. Add a place above, then use the current choices.</p>
      )}
      {metrics.length > 0 ? (
        <div>
          <span>Measures</span>
          {metrics.map((metric) => (
            <button
              key={metric}
              type="button"
              aria-pressed={metricKeys.includes(metric)}
              onClick={() => toggleMetric(metric)}
            >
              {metric}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" disabled={!canResolve} onClick={resolve}>
        Use these choices
      </button>
      {error ? (
        <p role="status" aria-live="polite">
          {error}
        </p>
      ) : null}
    </section>
  )
}
