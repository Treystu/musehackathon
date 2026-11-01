/**
 * Saved comparisons, held in this browser.
 *
 * A saved search here is a named set of ZIP codes — the same thing a shared URL
 * carries, kept locally instead of sent to someone. It is deliberately nothing
 * more than that: no sort, no preset, no filter bounds, because a saved search
 * that remembered how you had ordered the table would be a ranking waiting to be
 * replayed, and this application does not choose orderings for anyone.
 *
 * Like the URL codec it mirrors (`src/core/url-state.ts`), every input is
 * validated: names are trimmed and capped, ZIP codes must be five digits,
 * duplicates collapse, and the count of entries is bounded so a storage key
 * cannot grow without limit. The list is capped rather than silently evicted,
 * and `save` reports refusal so the interface can say the drawer is full instead
 * of quietly dropping the oldest thing the reader kept.
 */
import { decodeComparison, encodeComparison } from './url-state'

const STORAGE_KEY = 'civicscope.saved-searches.v1'

/** Named, bounded, and small enough to read in one screen. */
export const MAX_SAVED = 20
export const MAX_NAME_LENGTH = 80

export interface SavedSearch {
  id: string
  name: string
  zips: string[]
  savedAt: number
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    // Private mode or storage disabled: saved searches are unavailable, not
    // broken. The interface treats null as "cannot save here" and says so.
    return null
  }
}

/** Reads the saved list, returning [] for anything unreadable or invalid. */
export function readSaved(): SavedSearch[] {
  const store = storage()
  if (!store) return []
  let raw: unknown
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null')
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: SavedSearch[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.savedAt !== 'number') continue
    // The ZIP codes are re-validated through the same codec the URL uses, so a
    // hand-edited storage entry cannot smuggle a nonsense selection in.
    const zips = Array.isArray(e.zips) ? decodeComparison(e.zips.join(',')) : []
    if (zips.length === 0) continue
    out.push({ id: e.id, name: e.name.slice(0, MAX_NAME_LENGTH), zips, savedAt: e.savedAt })
  }
  // Newest first. Array.prototype.sort is stable by specification, and the
  // stored order is already newest-first by construction — saveSearch prepends —
  // so entries saved within the same millisecond keep their save order. An
  // earlier version broke ties by id string, which reorders same-millisecond
  // saves arbitrarily; a CI runner hit exactly that, failing the newest-first
  // assertion on two saves 0ms apart, and the honest fix is to let the sort's
  // stability do the work rather than inventing a tiebreak.
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SAVED)
}

/** True when the drawer is full and a save would be refused. */
export function isFull(): boolean {
  return readSaved().length >= MAX_SAVED
}

/**
 * Adds a saved comparison, or returns null if it could not be saved.
 *
 * Null — rather than throwing — for a full drawer, an empty name after
 * trimming, or storage being unavailable, because all three are ordinary states
 * the interface needs to describe in words, not exceptional ones.
 */
export function saveSearch(name: string, zips: readonly string[]): SavedSearch | null {
  const clean = name.trim().slice(0, MAX_NAME_LENGTH)
  const encoded = encodeComparison(zips)
  if (clean === '' || encoded === null) return null
  const store = storage()
  if (!store) return null
  const list = readSaved()
  if (list.length >= MAX_SAVED) return null
  const entry: SavedSearch = {
    // Random id with a timestamp fallback: enough to be unique within one
    // browser without depending on crypto in every context.
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: clean,
    zips: decodeComparison(encoded),
    savedAt: Date.now(),
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify([entry, ...list]))
  } catch {
    return null
  }
  return entry
}

/** Removes one entry by id. Removing something absent is not an error. */
export function deleteSearch(id: string): void {
  const store = storage()
  if (!store) return
  const kept = readSaved().filter((s) => s.id !== id)
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch {
    /* nothing to do; the list stays as it was */
  }
}
