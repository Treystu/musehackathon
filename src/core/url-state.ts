/**
 * A comparison carried in the URL, so a reader can send exactly what they see.
 *
 * The constraint that decides the shape: **a share link carries the selected ZIP
 * codes and nothing else.** Not a sort, not a preset, not a profile, not a
 * ranking — those are choices about how to look at data, and encoding them would
 * make a link a recommendation rather than a view. The phase record for this
 * feature says the same thing in different words: `encode the selected ZIP codes,
 * not a ranking or a profile`, with input validation.
 *
 * Validation is strict because the input is the outside world. Anything in a
 * shared URL arrives from anyone, including a person editing the address bar by
 * hand, and the reader's browser will act on it — so a malformed entry is dropped
 * silently rather than passed through or thrown. A link containing nonsense
 * should load the site normally and simply not pre-select the nonsense, which is
 * also what happens with an empty or absent parameter.
 *
 * `history.replaceState` rather than `pushState` on every change: adding a fifth
 * ZIP code is one action, not five pages of history, and a reader pressing Back
 * should leave the site rather than step through their own selection one removal
 * at a time.
 */

/** The query parameter the comparison travels under. */
export const COMPARISON_PARAM = 'z'

/** Hard cap, because a URL is not a database. */
export const MAX_SHARED = 12

/** True for exactly five digits — the only thing that can name a ZCTA here. */
function isZip(value: string): boolean {
  return /^\d{5}$/.test(value)
}

/**
 * Encodes a selection for the URL, or returns null when there is nothing to
 * carry. Empty and null selections produce the same thing — no parameter — so a
 * link with nothing selected is just the site.
 */
export function encodeComparison(zips: readonly string[]): string | null {
  const valid = [...new Set(zips)].filter(isZip).sort()
  if (valid.length === 0) return null
  return valid.slice(0, MAX_SHARED).join(',')
}

/**
 * Decodes a parameter value into the ZIP codes it names.
 *
 * Every entry must validate; every invalid entry is dropped, and duplicates
 * collapse, so a hand-edited `?z=78701,banana,78701` pre-selects Austin once and
 * carries on. Order is not preserved from the URL — the comparison has no
 * meaningful order, and sorting makes the encoding canonical, so the same
 * selection always produces the same link and the same link always selects the
 * same set.
 */
export function decodeComparison(param: string | null): string[] {
  if (!param) return []
  return [...new Set(param.split(',').map((v) => v.trim()).filter(isZip))]
    .sort()
    .slice(0, MAX_SHARED)
}

/** Reads the comparison out of a URL's query string. Exported for tests. */
export function decodeUrl(url: string): string[] {
  try {
    const search = new URL(url).searchParams
    return decodeComparison(search.get(COMPARISON_PARAM))
  } catch {
    return []
  }
}

/**
 * The URL to move to for a selection: the current URL with the parameter set,
 * cleared, or left absent. Returns the input unchanged when there is nothing to
 * change, so the caller can call it unconditionally and only touch history when
 * something actually moved.
 *
 * Built by hand rather than through `searchParams`, because searchParams encodes
 * a comma as `%2C` — correct, but a share link is something people read and edit
 * by hand, and `?z=10001,78701` is both legal and friendlier than
 * `?z=10001%2C78701`. A comma typed literally into the address bar decodes
 * identically, so hand-edited links keep working either way. Everything else
 * still encodes properly.
 */
export function urlForSelection(current: string, zips: readonly string[]): string {
  let u: URL
  try {
    u = new URL(current)
  } catch {
    return current
  }
  const encoded = encodeComparison(zips)
  const existing = u.searchParams.get(COMPARISON_PARAM)
  // Nothing to carry and nothing to remove: leave the URL untouched.
  if (encoded === null && existing === null) return current
  // Already carrying exactly this selection: no history entry for a no-op.
  if (encoded !== null && existing === encoded) return current

  const kept: [string, string][] = [...u.searchParams.entries()].filter(([k]) => k !== COMPARISON_PARAM)
  const pairs: [string, string][] =
    encoded === null ? kept : [...kept, [COMPARISON_PARAM, encoded]]
  const enc = (v: string) => encodeURIComponent(v).replace(/%2C/g, ',')
  const search = pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
  return `${u.origin}${u.pathname}${search ? `?${search}` : ''}${u.hash}`
}
