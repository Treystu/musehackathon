import { useState, type FormEvent } from 'react'
import { DISPLAYABLE_KEYS, FILTER_LEGAL_KEYS } from '../../core/ai/intent-schema'
import {
  addFilter,
  addGeography,
  addMetricKey,
  type IntentEditResult,
  type IntentFilter,
} from '../../core/ai/intent-edit'
import type { ValidatedIntent } from '../../core/ai/provider'
import { IntentChips } from './IntentChips'

const EDIT_ERROR_COPY: Record<string, string> = {
  not_allowlisted: 'That measure is not on the approved list.',
  proxy_metric_blocked: 'That measure cannot be used as a filter.',
  shape_invalid: 'That value is not valid.',
  empty_geography: 'Enter a place first.',
  clarification_required: 'Choose a place before continuing.',
}

function errorCopy(error: string): string {
  return EDIT_ERROR_COPY[error] ?? 'That change is not allowed.'
}

function apply(result: IntentEditResult, onChange: (next: ValidatedIntent) => void): boolean {
  if (result.ok) {
    onChange(result.intent)
    return true
  }
  return false
}

/** Chips plus add/remove controls. The parent owns the validated intent. */
export function IntentEditor({
  intent,
  onChange,
}: {
  intent: ValidatedIntent
  onChange: (next: ValidatedIntent) => void
}) {
  const [place, setPlace] = useState('')
  const [metric, setMetric] = useState<string>(DISPLAYABLE_KEYS[0] as string)
  const [filterMetric, setFilterMetric] = useState<string>(FILTER_LEGAL_KEYS[0] as string)
  const [filterOp, setFilterOp] = useState<IntentFilter['op']>('gt')
  const [filterValue, setFilterValue] = useState('0')
  const [error, setError] = useState('')

  function onAddPlace(e: FormEvent) {
    e.preventDefault()
    const result = addGeography(intent, place)
    if (apply(result, onChange)) {
      setPlace('')
      setError('')
    } else if (!result.ok) {
      setError(errorCopy(result.error))
    }
  }

  function onAddMetric(e: FormEvent) {
    e.preventDefault()
    const result = addMetricKey(intent, metric)
    if (apply(result, onChange)) setError('')
    else if (!result.ok) setError(errorCopy(result.error))
  }

  function onAddFilter(e: FormEvent) {
    e.preventDefault()
    const value = Number(filterValue)
    if (filterValue.trim() === '' || !Number.isFinite(value)) {
      setError(errorCopy('shape_invalid'))
      return
    }
    const result = addFilter(intent, { metricKey: filterMetric, op: filterOp, value })
    if (apply(result, onChange)) setError('')
    else if (!result.ok) setError(errorCopy(result.error))
  }

  return (
    <section aria-label="Edit the understood request">
      <IntentChips
        intent={intent}
        onChange={(next) => {
          onChange(next)
          setError('')
        }}
        onError={(code) => setError(errorCopy(code))}
      />

      <form onSubmit={onAddPlace}>
        <label htmlFor="intent-place">Add a place</label>
        <input
          id="intent-place"
          value={place}
          onChange={(e) => setPlace(e.target.value)}
          autoComplete="off"
        />
        <button type="submit">Add place</button>
      </form>

      <form onSubmit={onAddMetric}>
        <label htmlFor="intent-metric">Add a measure</label>
        <select
          id="intent-metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
        >
          {DISPLAYABLE_KEYS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <button type="submit">Add measure</button>
      </form>

      <form onSubmit={onAddFilter}>
        <fieldset>
          <legend>Add a filter</legend>
          <label htmlFor="filter-metric">Measure</label>
          <select
            id="filter-metric"
            value={filterMetric}
            onChange={(e) => setFilterMetric(e.target.value)}
          >
            {FILTER_LEGAL_KEYS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <label htmlFor="filter-op">Comparison</label>
          <select
            id="filter-op"
            value={filterOp}
            onChange={(e) => setFilterOp(e.target.value as IntentFilter['op'])}
          >
            <option value="gt">greater than</option>
            <option value="lt">less than</option>
            <option value="eq_range">equal to</option>
          </select>
          <label htmlFor="filter-value">Value</label>
          <input
            id="filter-value"
            type="number"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
          />
          <button type="submit">Add filter</button>
        </fieldset>
      </form>

      {error ? (
        <p role="status" aria-live="polite">
          {error}
        </p>
      ) : null}
    </section>
  )
}
