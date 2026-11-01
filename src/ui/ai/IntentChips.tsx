import type { ValidatedIntent } from '../../core/ai/provider'
import {
  removeFilter,
  removeGeography,
  removeMetricKey,
  type IntentEditResult,
} from '../../core/ai/intent-edit'

function applyRemoval(
  result: IntentEditResult,
  onChange: (next: ValidatedIntent) => void,
  onError?: (error: string) => void,
): void {
  if (result.ok) {
    onChange(result.intent)
    return
  }
  onError?.(result.error)
}

/** Visible, correctable representation of the validated intent. */
export function IntentChips({
  intent,
  onChange,
  onError,
}: {
  intent: ValidatedIntent
  onChange: (next: ValidatedIntent) => void
  onError?: (error: string) => void
}) {
  const chipClass =
    'inline-flex min-h-[36px] items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-800 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
  return (
    <div aria-label="What was understood" className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-slate-900">{intent.mode}</span>
      {intent.geographies.map((g) => (
        <button
          key={`geo-${g}`}
          type="button"
          aria-label={`Remove place ${g}`}
          onClick={() => applyRemoval(removeGeography(intent, g), onChange, onError)}
          className={chipClass}
        >
          {g} ×
        </button>
      ))}
      {intent.metricKeys.map((k) => (
        <button
          key={`metric-${k}`}
          type="button"
          aria-label={`Remove measure ${k}`}
          onClick={() => applyRemoval(removeMetricKey(intent, k), onChange, onError)}
          className={chipClass}
        >
          {k} ×
        </button>
      ))}
      {intent.filters.map((f, index) => {
        const label = `${f.metricKey} ${f.op} ${f.value}`
        return (
          <button
            key={`filter-${index}-${label}`}
            type="button"
            aria-label={`Remove filter ${label}`}
            onClick={() => applyRemoval(removeFilter(intent, f), onChange, onError)}
            className={chipClass}
          >
            {label} ×
          </button>
        )
      })}
    </div>
  )
}
