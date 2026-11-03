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

type AddKind = 'place' | 'measure' | 'filter'

/** Chips plus add/remove controls. The parent owns the validated intent. */
export function IntentEditor({
  intent,
  onChange,
  suppressAddForms = false,
}: {
  intent: ValidatedIntent
  onChange: (next: ValidatedIntent) => void
  /**
   * One editing surface during clarification (item-16 cure C3):
   * while the clarification panel is mounted it owns every
   * addition, so the editor renders its removal chips only — two
   * live add-paths for the same intent object was the audit's
   * split-surface finding.
   */
  suppressAddForms?: boolean
}) {
  const [kind, setKind] = useState<AddKind>('place')
  const [place, setPlace] = useState('')
  const [metric, setMetric] = useState('')
  const [filterMetric, setFilterMetric] = useState<string>(FILTER_LEGAL_KEYS[0] as string)
  const [filterOp, setFilterOp] = useState<IntentFilter['op']>('gt')
  const [filterValue, setFilterValue] = useState('0')
  const [error, setError] = useState('')

  function fail(result: IntentEditResult) {
    if (!result.ok) setError(errorCopy(result.error))
  }

  function onAddMeasure(key: string) {
    // A measure is enumerable, so choosing one IS the addition
    // (item-16 cure C9): no second submit act stands between the
    // pick and the intent. The select returns to its placeholder
    // so the next pick is a fresh choice, never a stale value
    // re-submitted.
    if (!key) return
    const result = addMetricKey(intent, key)
    if (apply(result, onChange)) {
      setError('')
      setMetric('')
    } else {
      fail(result)
    }
  }

  function onAdd(e: FormEvent) {
    e.preventDefault()
    if (kind === 'place') {
      const result = addGeography(intent, place)
      if (apply(result, onChange)) {
        setPlace('')
        setError('')
      } else {
        fail(result)
      }
      return
    }
    if (kind === 'filter') {
      const value = Number(filterValue)
      if (filterValue.trim() === '' || !Number.isFinite(value)) {
        setError(errorCopy('shape_invalid'))
        return
      }
      const result = addFilter(intent, { metricKey: filterMetric, op: filterOp, value })
      if (apply(result, onChange)) setError('')
      else fail(result)
    }
    // kind === 'measure' never reaches the submit: choosing the
    // measure already added it (onAddMeasure above).
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
        chips above stay visible — they are what ran — while the add
        row sits behind one disclosure for readers who want to dig in.

        One add row (item-16 cure C9): the editor used to re-present
        the intent as three separate add-forms (place / measure /
        filter), each with its own submit button — type+submit per
        field for one intent object. There is now a single form: a
        field-type selector, that type's input, and one Add — and a
        measure, being enumerable, adds on selection with no Add at
        all.
      */}
      {!suppressAddForms && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Adjust this request
          </summary>
          <div className="mt-3">
            <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
              <label htmlFor="intent-add-kind" className="text-sm font-medium text-slate-900">
                Add a
                <select
                  id="intent-add-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as AddKind)}
                  className="select-field mt-1 block"
                >
                  <option value="place">place</option>
                  <option value="measure">measure</option>
                  <option value="filter">filter</option>
                </select>
              </label>

              {kind === 'place' && (
                <label htmlFor="intent-place" className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                  Place
                  <input
                    id="intent-place"
                    value={place}
                    onChange={(e) => setPlace(e.target.value)}
                    autoComplete="off"
                    className="field mt-1 w-full"
                  />
                </label>
              )}

              {kind === 'measure' && (
                <label htmlFor="intent-metric" className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                  Measure
                  <select
                    id="intent-metric"
                    value={metric}
                    onChange={(e) => {
                      setMetric(e.target.value)
                      onAddMeasure(e.target.value)
                    }}
                    className="select-field mt-1 w-full"
                  >
                    <option value="">Choose a measure</option>
                    {/* Option text is the plain-language label (owner finding
                        F-B, 2026-11-02); the value carried stays the key. */}
                    {DISPLAYABLE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {measureLabel(key)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {kind === 'filter' && (
                <>
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
                </>
              )}

              {kind !== 'measure' && (
                <button type="submit" className="btn-secondary shrink-0">
                  Add
                </button>
              )}
            </form>
          </div>
        </details>
      )}

      {error ? (
        <p role="status" aria-live="polite" className="text-sm text-slate-700">
          {error}
        </p>
      ) : null}
    </section>
  )
}
