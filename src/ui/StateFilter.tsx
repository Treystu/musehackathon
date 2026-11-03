import { useEffect, useId, useRef, useState } from 'react'
import { toggleStateOption, type StateOption } from '../core/sweep/states'

/**
 * State pre-filter for the country-wide screen.
 *
 * This is the difference between a two-second wait and a two-minute one. The
 * screen loads in chunks, so narrowing to a region before it starts means
 * fetching three chunks instead of thirty-four. The cost is shown before the
 * work begins rather than discovered halfway through, because a progress bar
 * that does not know its own length is a progress bar nobody trusts.
 */
export function StateFilter({
  options,
  selected,
  onToggle,
  onClear,
  onApplyScope,
  totalChunks,
  scopeChunks,
  busy,
}: {
  options: StateOption[]
  /** The current scope as ZIP prefixes; a state reads as selected when all
   * of its prefixes are in the scope. */
  selected: string[]
  onToggle: (option: StateOption) => void
  onClear: () => void
  /**
   * Applies a scope (the prefix list) as the live selection — called
   * once per coalesced change-set, never per tick (see handleToggle).
   */
  onApplyScope: (next: string[]) => void
  totalChunks: number
  scopeChunks: number
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The selection the pending coalesced apply will carry. Ticks
  // inside the window accumulate from this, not from the `selected`
  // prop, so two ticks landing before a re-render cannot lose the
  // first one.
  const pendingSelection = useRef<string[] | null>(null)

  useEffect(
    () => () => {
      if (applyTimer.current) clearTimeout(applyTimer.current)
    },
    [],
  )

  /**
   * Apply on tick (item-16 cure C5): the tick IS the decision, the
   * same live model the figure bounds beside this panel already use.
   * The old tick-then-Apply split one decision into two acts and
   * left ticks visibly doing nothing until the confirm click.
   *
   * Coalescing is the risk control the audit named: applyScope
   * restarts the country sweep load, so a reader ticking five
   * states in a row must not start five loads. Ticks inside the
   * window collapse into one applyScope call carrying the final
   * selection; loadSweep aborts the superseded load, so even a
   * late second call cannot stack work.
   */
  function handleToggle(option: StateOption) {
    onToggle(option)
    const next = toggleStateOption(pendingSelection.current ?? selected, option)
    pendingSelection.current = next
    if (applyTimer.current) clearTimeout(applyTimer.current)
    applyTimer.current = setTimeout(() => {
      applyTimer.current = null
      const finalSelection = pendingSelection.current ?? next
      pendingSelection.current = null
      onApplyScope(finalSelection)
    }, 400)
  }

  function handleClear() {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current)
      applyTimer.current = null
    }
    pendingSelection.current = null
    onClear()
    onApplyScope([])
  }
  const selectedOptions = options.filter((o) => o.prefixes.every((p) => selected.includes(p)))
  const selectedText =
    selectedOptions.length > 0 && selectedOptions.flatMap((o) => o.prefixes).length === selected.length
      ? selectedOptions.map((o) => o.label).join(', ')
      : selected.join(', ')

  return (
    <div className="panel panel-padded">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Narrow to a state or several</h2>
          <p className="mt-1 text-sm text-slate-600">
            The whole country loads in {totalChunks} small requests and takes a couple of minutes. Choosing
            states first fetches far less and finishes in seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={listId}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          {open ? 'Hide states' : 'Choose states'}
        </button>
      </div>

      {selected.length > 0 && (
        <p className="mt-2 text-sm text-slate-800">
          <span className="font-medium">Selected:</span> {selectedText} — about{' '}
          {scopeChunks} {scopeChunks === 1 ? 'request' : 'requests'}.
        </p>
      )}

      {open && (
        <div id={listId} className="mt-3">
          <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto" role="group" aria-label="States">
            {options.map((o) => (
              <label
                key={o.code}
                className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-sm ${
                  o.prefixes.every((p) => selected.includes(p))
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={o.prefixes.every((p) => selected.includes(p))}
                  onChange={() => handleToggle(o)}
                  className="sr-only"
                />
                {o.label}
                <span className="ml-1.5 text-xs opacity-70">{num.format(o.count)}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleClear}
              disabled={busy || selected.length === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const num = new Intl.NumberFormat('en-US')
