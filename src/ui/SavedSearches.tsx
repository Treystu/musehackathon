/**
 * Saved comparisons, kept in this browser.
 *
 * A saved comparison is the same thing a shared URL carries — a set of ZIP
 * codes — kept locally instead of sent to anyone. The save/restore actions live
 * here as one small panel so they are the same everywhere the comparison is
 * shown.
 *
 * Design decisions, each inherited from something that went wrong before:
 *
 * **Validation is the codec's, not this panel's.** Names are trimmed and capped,
 * ZIP codes go through the same `url-state` encoder a share link uses, so a
 * saved comparison cannot hold anything a link could not.
 *
 * **A full drawer refuses rather than evicts.** Silently dropping the oldest
 * entry to make room for a new one is how a saved list teaches its owner never
 * to trust it.
 *
 * **Storage failures are states, not exceptions.** A browser in private mode
 * can still use the whole rest of the app; the panel says saving is unavailable
 * instead of throwing.
 */
import { useState } from 'react'
import type { MuseProvider } from '../core/ai/provider'

import {
  isFull,
  readSaved,
  saveSearch,
  deleteSearch,
  type SavedSearch,
} from '../core/saved-searches'
import { ExplainAction } from './ai/ExplainAction'
import type { FigureInput } from './ai/FigureCard'

const num = new Intl.NumberFormat('en-US')

export function SavedSearches({
  selectedZctas,
  onRestore,
  explainProvider,
  figuresForSaved,
}: {
  selectedZctas: readonly string[]
  /** Adds every ZIP code in a saved comparison to the current one. */
  onRestore: (zips: readonly string[]) => void
  explainProvider?: MuseProvider
  figuresForSaved?: (zips: readonly string[]) => readonly FigureInput[]
}) {
  const [list, setList] = useState<SavedSearch[]>(() => readSaved())
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const canSave = selectedZctas.length > 0 && !isFull()

  function save() {
    const entry = saveSearch(name, selectedZctas)
    if (!entry) {
      // Refused: full drawer, blank name, or storage unavailable. All three are
      // ordinary states this panel must describe rather than swallow.
      setNote(
        isFull()
          ? `The saved list is full at ${readSaved().length} entries. Remove one to make room.`
          : 'Could not save. Your browser may have storage disabled.',
      )
      return
    }
    setName('')
    setNote(null)
    setList(readSaved())
  }

  function remove(id: string) {
    deleteSearch(id)
    setList(readSaved())
  }

  if (list.length === 0 && !canSave && selectedZctas.length === 0) return null

  return (
    <section aria-labelledby="saved-heading" className="mt-4 panel panel-padded">
      <h2 id="saved-heading" className="text-sm font-semibold text-slate-900">
        Saved comparisons
      </h2>
      <p className="mt-1 text-xs text-slate-600">
        Kept in this browser only. A saved comparison is a set of ZIP codes and nothing else — never an ordering or a
        filter.
      </p>

      {canSave && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <label htmlFor="saved-name" className="sr-only">
            Name for this comparison
          </label>
          <input
            id="saved-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`Name these ${num.format(selectedZctas.length)} areas`}
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          />
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
          >
            Save
          </button>
        </form>
      )}

      {note && (
        <p className="mt-2 text-sm text-amber-900" role="status">
          {note}
        </p>
      )}

      {list.length > 0 ? (
        <ul className="mt-2 divide-y divide-slate-100">
          {list.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <div className="min-w-0">
                <span className="text-sm font-medium text-slate-900">{entry.name}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {entry.zips.length} ZIP {entry.zips.length === 1 ? 'code' : 'codes'}
                </span>
              </div>
              <div className="flex gap-2">
                {explainProvider && figuresForSaved && (
                  <ExplainAction
                    title="this saved comparison"
                    figureSetId="saved-view"
                    figures={figuresForSaved(entry.zips)}
                    provider={explainProvider}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onRestore(entry.zips)}
                  className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                >
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => remove(entry.id)}
                  aria-label={`Remove ${entry.name} from the saved list`}
                  className="min-h-[44px] rounded-md px-2 py-2 text-xs text-slate-600 underline hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Nothing saved yet. Select some areas above, then name the comparison to keep it.
        </p>
      )}
    </section>
  )
}
