/**
 * City search over the baked ZIP-to-place mapping.
 *
 * No network request, and that is the point rather than an optimisation.
 * `src/core/geocode.ts` records that a public OSM geocoder exhausted its request
 * budget during a 370-ZIP audit and then refused connections — and because the
 * limits are per-IP, that failure would reach every visitor of the deployed site.
 * An autocomplete asks on every keystroke, so it would be that failure at a far
 * higher rate, and it would hand a third party a log of what people searched
 * for, which is the one claim `docs/governance.md` rests on.
 *
 * The combobox pattern is the accessible one. An editable combobox keeps focus in
 * the text field at all times and moves a virtual cursor with
 * `aria-activedescendant`, which is why the option list is not focusable and no
 * `role="listbox"` container is required on a wrapper: the input owns the
 * relationship. Screen readers announce the expanded state, the active option and
 * the result count from live regions owned here.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { PlaceSuggestion } from '../core/zcta-place-index'

/** Suggestions shown at once. Eight fits a 44px-tall row list on a laptop. */
const MAX_SUGGESTIONS = 8

export interface SearchAutocompleteProps {
  value: string
  onChange: (value: string) => void
  /** Fired when a suggestion is chosen, by click or by Enter. */
  onChoose: (place: PlaceSuggestion) => void
  /** The loaded index, or null while it loads or if it could not be fetched. */
  search: (query: string, limit?: number) => PlaceSuggestion[]
  /** True while the mapping is still being fetched. */
  loading: boolean
}

export function SearchAutocomplete({
  value,
  onChange,
  onChoose,
  search,
  loading,
}: SearchAutocompleteProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [announcement, setAnnouncement] = useState('')
  const blurTimer = useRef<number | null>(null)
  const listId = useId()

  // A five-digit code is a ZIP lookup, not a place search, so no suggestions are
  // offered for it. Doing otherwise would bury the direct answer under cities
  // whose names happen to contain those digits.
  const isZip = /^\d{5}$/.test(value.trim())
  const suggestions = useMemo(
    () => (loading || isZip || value.trim().length < 2 ? [] : search(value, MAX_SUGGESTIONS)),
    [search, value, loading, isZip],
  )

  const expanded = open && suggestions.length > 0

  // Announce the count rather than relying on the option text being read, which
  // is unreliable while the list is changing under a cursor.
  useEffect(() => {
    if (!expanded) {
      setAnnouncement('')
      return
    }
    setAnnouncement(
      suggestions.length === 1 ? '1 suggestion available.' : `${suggestions.length} suggestions available.`,
    )
  }, [expanded, suggestions.length])

  // A changed query invalidates the highlighted row. Without this, ArrowDown after
  // editing lands on an arbitrary option of the new list.
  useEffect(() => {
    setActive(-1)
  }, [value])

  function choose(place: PlaceSuggestion) {
    onChoose(place)
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (expanded) {
        // Escape closes the list and keeps the text, so a mistyped query can be
        // corrected rather than retyped.
        e.preventDefault()
        setOpen(false)
        setActive(-1)
      }
      return
    }
    if (!expanded) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      // Only intercept Enter when a row is highlighted, so submitting the form
      // with the keyboard still works.
      e.preventDefault()
      choose(suggestions[active]!)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(suggestions.length - 1)
    }
  }

  return (
    <div className="relative">
      <input
        id="place"
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={`${listId}-hint`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        // Deferred rather than immediate: clicking an option blurs the input
        // first, and closing synchronously would unmount the list before the
        // click landed. The option's onMouseDown prevents the blur entirely,
        // and this is the fallback for a click on the surrounding area.
        onBlur={() => {
          if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
          blurTimer.current = window.setTimeout(() => {
            setOpen(false)
            setActive(-1)
          }, 120)
        }}
        onKeyDown={onKeyDown}
        placeholder="e.g. 78701 or Austin, TX"
        autoComplete="off"
        className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
      />

      <p id={`${listId}-hint`} className="sr-only">
        Search by five-digit US ZIP code, or by city and state. City suggestions come from the Census Bureau and
        list every ZIP code in the matched city.
      </p>

      {/*
        The status region is always present and always empty when idle. A live
        region that is inserted into the DOM at the same moment as its text is
        frequently not announced at all, because the assistive technology has
        nothing to observe yet.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching cities"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-md border border-slate-300 bg-white py-1 shadow-lg"
        >
          {suggestions.map((place, i) => {
            const selected = i === active
            const where = place.isCity ? `${place.zips.length} ZIP ${place.zips.length === 1 ? 'code' : 'codes'}` : 'county, no incorporated city'
            return (
              <li
                key={`${place.displayName}-${place.state}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                // onMouseDown rather than onClick: it fires before the input
                // loses focus, so the list is still mounted to receive the
                // choice. This is also why the blur handler above defers.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(place)
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                  selected ? 'bg-slate-900 text-white' : 'text-slate-800 hover:bg-slate-100'
                }`}
              >
                <span className="font-medium">
                  {place.displayName}, {place.state}
                </span>
                <span className={selected ? 'text-slate-200' : 'text-slate-500'}>{where}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
