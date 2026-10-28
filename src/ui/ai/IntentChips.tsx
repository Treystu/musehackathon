import type { ValidatedIntent } from '../../core/ai/provider'

/** Visible, correctable representation of the validated intent. */
export function IntentChips({
  intent,
  onChange,
}: {
  intent: ValidatedIntent
  onChange: (next: ValidatedIntent) => void
}) {
  return (
    <div aria-label="What was understood">
      <span>{intent.mode}</span>
      {intent.geographies.map((g) => (
        <button
          key={`geo-${g}`}
          type="button"
          aria-label={`Remove place ${g}`}
          onClick={() =>
            onChange({ ...intent, geographies: intent.geographies.filter((x) => x !== g) })
          }
        >
          {g} ×
        </button>
      ))}
      {intent.metricKeys.map((k) => (
        <button
          key={`metric-${k}`}
          type="button"
          aria-label={`Remove measure ${k}`}
          onClick={() =>
            onChange({ ...intent, metricKeys: intent.metricKeys.filter((x) => x !== k) })
          }
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
            onClick={() =>
              onChange({
                ...intent,
                filters: intent.filters.filter(
                  (x) =>
                    !(x.metricKey === f.metricKey && x.op === f.op && x.value === f.value),
                ),
              })
            }
          >
            {label} ×
          </button>
        )
      })}
    </div>
  )
}
