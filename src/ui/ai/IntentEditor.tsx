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
import { measureLabel } from './plain-labels'

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
    <section aria-label="Edit the understood request" className="mt-4 space-y-3">
      <IntentChips
        intent={intent}
        onChange={(next) => {
          onChange(next)
          setError('')
        }}
        onError={(code) => setError(errorCopy(code))}
      />

      {/*
        Clean by default (owner directive, 2026-11-01): the understood
        chips above stay visible — they are what ran — while the
        add-place / add-measure / add-filter forms sit behind one
        disclosure for readers who want to dig in.
      */}
      <details>
        <summary className="cursor-pointer text-sm font-medium text-slate-700">
          Adjust this request
        </summary>
        <div className="mt-3 space-y-3">
      <form onSubmit={onAddPlace} className="flex flex-wrap items-end gap-2">
        <label htmlFor="intent-place" className="min-w-0 flex-1 text-sm font-medium text-slate-900">
          Add a place
          <input
            id="intent-place"
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            autoComplete="off"
            className="field mt-1 w-full"
          />
        </label>
        <button type="submit" className="btn-secondary shrink-0">
          Add place
        </button>
      </form>

      <form onSubmit={onAddMetric} className="flex flex-wrap items-end gap-2">
        <label htmlFor="intent-metric" className="min-w-0 flex-1 text-sm font-medium text-slate-900">
          Add a measure
          <select
            id="intent-metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="select-field mt-1 w-full"
          >
            {/* Option text is the plain-language label (owner finding
                F-B, 2026-11-02); the value carried stays the key. */}
            {DISPLAYABLE_KEYS.map((key) => (
              <option key={key} value={key}>
                {measureLabel(key)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-secondary shrink-0">
          Add measure
        </button>
      </form>

      <form onSubmit={onAddFilter}>
        <fieldset className="flex flex-wrap items-end gap-2">
          <legend className="text-sm font-medium text-slate-900">Add a filter</legend>
          <label htmlFor="filter-metric" className="text-sm font-medium text-slate-900">
            Measure
            <select
              id="filter-metric"
              value={filterMetric}
              onChange={(e) => setFilterMetric(e.target.value)}
              className="select-field mt-1 block"
            >
              {FILTER_LEGAL_KEYS.map((key) => (
                <option key={key} value={key}>
                  {measureLabel(key)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="filter-op" className="text-sm font-medium text-slate-900">
            Comparison
            <select
              id="filter-op"
              value={filterOp}
              onChange={(e) => setFilterOp(e.target.value as IntentFilter['op'])}
              className="select-field mt-1 block"
            >
              <option value="gt">greater than</option>
              <option value="lt">less than</option>
              <option value="eq_range">equal to</option>
            </select>
          </label>
          <label htmlFor="filter-value" className="text-sm font-medium text-slate-900">
            Value
            <input
              id="filter-value"
              type="number"
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              className="field mt-1 block w-32 flex-none"
            />
          </label>
          <button type="submit" className="btn-secondary shrink-0">
            Add filter
          </button>
        </fieldset>
      </form>
        </div>
      </details>

      {error ? (
        <p role="status" aria-live="polite" className="text-sm text-slate-700">
          {error}
        </p>
      ) : null}
    </section>
  )
}
