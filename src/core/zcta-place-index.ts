/**
 * Which city a ZIP code is in, from a committed Census artefact.
 *
 * The app could ask before it answered. It does not, for two reasons that were
 * measured rather than assumed.
 *
 * The first is cost: a country-wide screening table has 33,791 rows, and a geocode
 * per row would be 33,791 requests against a daily allowance of 450. The mapping
 * is baked instead, served from `/map/` under an immutable year-long header, so
 * it costs one request the first time and nothing thereafter.
 *
 * The second is the one that decided it. `geocode.ts` records that a 370-ZIP
 * audit exhausted a public OSM geocoder's budget and that it then refused
 * connections — and because the limits are per-IP, that failure would apply to
 * every visitor of the deployed site, not just to the build machine. A city
 * search that asks a third party on every keystroke is the same mistake at a
 * higher request rate. It also contradicts the claim `docs/governance.md` rests
 * on, that nobody can see who searched for what.
 *
 * Names are stored exactly as the Census Bureau publishes them and are shortened
 * for display here rather than in the generator. Two reasons: a mapping that is
 * subtly wrong is worse than none, because it looks right; and the published name
 * is auditable against the source file by string comparison.
 */

/** A ZIP code resolved to the place that overlaps it most. */
export interface PlaceRecord {
  zip: string
  /** `NAMELSAD_PLACE_20` verbatim, e.g. `Salt Lake City city`. */
  censusName: string
  /** The same name with its Census legal type removed, e.g. `Salt Lake City`. */
  displayName: string
  /** Postal abbreviation, e.g. `UT`. */
  state: string
  /** False where the ZIP has no incorporated city and falls back to its county. */
  isCity: boolean
  /** True for an incorporated place (MTFCC G4110); false for a statistical area. */
  incorporated: boolean
}

/** One distinct place, with every ZIP code that resolves to it. */
export interface PlaceSuggestion {
  displayName: string
  censusName: string
  state: string
  isCity: boolean
  zips: string[]
}

export const ZCTA_PLACES_URL = '/map/zcta-places.json'

/** Every ZCTA in the country. A short file is a bug, not a smaller dataset. */
export const EXPECTED_PLACE_COUNT = 33791

/**
 * Trailing legal-type phrases, longest first so `city (balance)` is preferred
 * over `city`.
 *
 * Case matters and is the whole trick. The Census Bureau writes a legal type in
 * lower case and a proper noun in upper, so `Amherst Town city` is the town of
 * Amherst Town and `Salt Lake City city` is the city of Salt Lake City. A
 * case-insensitive strip turns the first into `Amherst` and the second into
 * `Salt Lake`, both of which are wrong and neither of which looks wrong.
 */
const INCORPORATED_SUFFIXES = [
  'city (balance)',
  'unified government (balance)',
  'zona urbana',
  'municipality',
  'corporation',
  'borough',
  'comunidad',
  'village',
  'township',
  'town',
  'city',
]

/** Statistical areas carry their own type token, and no lower-case equivalent. */
const STATISTICAL_SUFFIXES = ['CDP', 'zona urbana', 'comunidad']

/**
 * Removes a trailing Census legal-type phrase, or returns the name untouched.
 *
 * Deliberately conservative, and verified against every distinct name in the
 * file rather than a sample. The cases that constrain it:
 *
 *   `Austin city`                             -> `Austin`
 *   `Anchorage municipality`                  -> `Anchorage`
 *   `Salt Lake City city`                     -> `Salt Lake City`   (upper-case C)
 *   `Amherst Town city`                       -> `Amherst Town`     (upper-case T)
 *   `Urban Honolulu CDP`                      -> `Urban Honolulu`
 *   `San Juan zona urbana`                    -> `San Juan`
 *   `Milford city (balance)`                  -> `Milford`
 *   `Athens-Clarke County unified government (balance)` -> `Athens-Clarke County`
 *   `Carroll County`                          -> `Carroll County`   (unchanged)
 *
 * The last one is the trap. There are census-designated places actually named
 * `Carroll County`, `Hampden County` and `Worcester County`. `County` is never a
 * place legal type, so it is absent from both lists above, and those names survive
 * intact — but only because the lists were derived from the file's own
 * legal-class column rather than guessed from the words that appear at the end of
 * names. Those trailing words were measured: alongside the genuine types they
 * include `County`, `Princeton` and `government`, none of which may be stripped.
 */
export function shortenPlaceName(name: string, incorporated: boolean): string {
  for (const suffix of incorporated ? INCORPORATED_SUFFIXES : STATISTICAL_SUFFIXES) {
    // The leading space is part of the test, so a name that *is* the type token
    // ("Princeton") is never reduced to nothing.
    if (name.length > suffix.length && name.endsWith(` ${suffix}`)) {
      return name.slice(0, -(suffix.length + 1))
    }
  }
  return name
}

/**
 * Rebuilds the ascending ZIP list from its delta encoding.
 *
 * Negative deltas are rejected rather than tolerated. Allowing one would produce
 * a duplicate or descending entry, and a duplicate is the quiet failure this
 * module exists to prevent: two records would describe one ZIP code, and the
 * second would silently overwrite the first in the lookup map.
 */
export function decodeZips(deltas: number[]): string[] {
  const zips: string[] = []
  let previous = -1
  for (const delta of deltas) {
    if (!Number.isInteger(delta) || delta < 0) {
      throw new Error(`ZIP delta must be a non-negative integer, got ${delta} at index ${zips.length}`)
    }
    previous += delta + 1
    if (previous > 99999) {
      throw new Error(`ZIP delta out of range at index ${zips.length}: ${previous}`)
    }
    zips.push(String(previous).padStart(5, '0'))
  }
  return zips
}

interface RawPlaces {
  v: number
  zd: number[]
  names: string[]
  states: string[]
  rec: string
}

/** Characters per record: 5-digit name, 2-digit state, kind, legal class. */
const RECORD_WIDTH = 9

/**
 * Turns the shipped payload into lookups.
 *
 * Throws rather than returning a partial index. Every count is cross-checked
 * because the failure mode is silent misalignment: record *k* belongs to the k-th
 * ZIP, so a file that decoded to 33,790 records would attach every city after the
 * gap to the wrong ZIP code and still render. A table that looks correct while
 * being wrong is the specific thing this codebase keeps designing against.
 */
export function decodePlaces(payload: unknown): {
  byZip: Map<string, PlaceRecord>
  places: PlaceSuggestion[]
} {
  const raw = payload as RawPlaces
  if (!raw || typeof raw !== 'object') throw new Error('place mapping is not an object')
  if (!Array.isArray(raw.zd) || !Array.isArray(raw.names) || !Array.isArray(raw.states)) {
    throw new Error('place mapping is missing zd/names/states')
  }
  if (typeof raw.rec !== 'string') throw new Error('place mapping is missing rec')

  const zips = decodeZips(raw.zd)
  if (zips.length !== raw.rec.length / RECORD_WIDTH) {
    throw new Error(
      `place mapping is misaligned: ${zips.length} ZIP codes but ${raw.rec.length / RECORD_WIDTH} records`,
    )
  }
  // Checked before the country-size assertion below, so that a duplicated or
  // out-of-order list reports what is actually wrong with it rather than only
  // its size.
  for (let i = 1; i < zips.length; i++) {
    if (zips[i]! <= zips[i - 1]!) throw new Error(`place mapping is not strictly ascending at ${zips[i]}`)
  }
  if (zips.length !== EXPECTED_PLACE_COUNT) {
    throw new Error(`place mapping holds ${zips.length} ZIP codes; the country has ${EXPECTED_PLACE_COUNT}`)
  }

  const byZip = new Map<string, PlaceRecord>()
  const byPlace = new Map<string, PlaceSuggestion>()

  for (let i = 0; i < zips.length; i++) {
    const record = raw.rec.slice(i * RECORD_WIDTH, i * RECORD_WIDTH + RECORD_WIDTH)
    const name = raw.names[Number(record.slice(0, 5))]
    const state = raw.states[Number(record.slice(5, 7))]
    const kind = record[7]
    const incorporated = record[8] === 'I'
    if (name === undefined || state === undefined) {
      throw new Error(`place mapping record ${i} points outside its dictionaries`)
    }
    const displayName = shortenPlaceName(name, incorporated)
    const zip = zips[i]!
    byZip.set(zip, { zip, censusName: name, displayName, state, isCity: kind === 'C', incorporated })

    const key = `${displayName}|${state}`
    let place = byPlace.get(key)
    if (!place) {
      place = { displayName, censusName: name, state, isCity: kind === 'C', zips: [] }
      byPlace.set(key, place)
    }
    place.zips.push(zip)
  }

  for (const place of byPlace.values()) place.zips.sort()
  const places = [...byPlace.values()]
  // A stable, explainable order: cities before county fallbacks, then by name,
  // then by state. Never by size, because "biggest first" is a ranking.
  places.sort(
    (a, b) =>
      Number(b.isCity) - Number(a.isCity) ||
      a.displayName.localeCompare(b.displayName, 'en') ||
      a.state.localeCompare(b.state, 'en'),
  )
  return { byZip, places }
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Ranks places against a query.
 *
 * The order is fixed and documented rather than clever: an exact name, then a
 * prefix, then a word-boundary match, then any substring. Ties break on the
 * stable order `decodePlaces` already applied, so the same query always produces
 * the same list — an autocomplete that reorders itself between keystrokes is
 * unusable with a keyboard.
 *
 * There is deliberately no tiebreak by size. "Austin, TX" and "Austin, AR" are
 * both correct answers to "austin", and ordering them by population would be this
 * app ranking places, which is the one thing it does not do. Both are offered,
 * each with the ZIP codes it covers, and the reader chooses.
 *
 * Matches are bucketed by rank and each bucket is capped, rather than truncating
 * the whole scan part-way through. An earlier version stopped after 400 scored
 * entries, which silently cut off better matches that happened to sit later in
 * the alphabetical scan — a common query dropped its own exact matches.
 */
export function searchPlaces(
  places: PlaceSuggestion[],
  query: string,
  limit = 8,
): PlaceSuggestion[] {
  const q = normalise(query)
  if (!q) return []

  const buckets: PlaceSuggestion[][] = [[], [], [], []]
  const CAP = 64

  for (const place of places) {
    const name = place.displayName.toLowerCase()
    let rank: number
    if (name === q) rank = 0
    else if (name.startsWith(q)) rank = 1
    else if (name.split(' ').some((word) => word.startsWith(q))) rank = 2
    else if (name.includes(q)) rank = 3
    else continue
    const bucket = buckets[rank]!
    if (bucket.length < CAP) bucket.push(place)
    // Exact and prefix buckets are small in practice; if one ever fills, stop
    // scanning entirely rather than degrade into substring noise.
    if (rank <= 1 && bucket.length >= CAP) break
  }

  const out: PlaceSuggestion[] = []
  for (const bucket of buckets) {
    for (const place of bucket) {
      if (out.length >= limit) return out
      out.push(place)
    }
  }
  return out
}

/** The index, once loaded. Cheap to query; the parse is the expensive part. */
export class PlaceIndex {
  constructor(
    readonly byZip: Map<string, PlaceRecord>,
    readonly places: PlaceSuggestion[],
  ) {}

  /** Where this ZIP code is, or null if it is not one of the 33,791. */
  lookup(zip: string): PlaceRecord | null {
    return this.byZip.get(zip) ?? null
  }

  /** `"Austin, TX"`, or null when the ZIP is unknown. */
  label(zip: string): string | null {
    const record = this.byZip.get(zip)
    if (!record) return null
    return `${record.displayName}, ${record.state}`
  }

  search(query: string, limit = 8): PlaceSuggestion[] {
    return searchPlaces(this.places, query, limit)
  }

  /** Every ZIP code in a place, ascending. */
  zipsIn(place: PlaceSuggestion): string[] {
    return place.zips
  }
}

let cached: Promise<PlaceIndex | null> | null = null

/**
 * Loads and caches the mapping.
 *
 * Resolves to `null` rather than rejecting when the file is unreachable. A
 * missing city index must not take the page down: ZIP lookup, the sweep and the
 * drilldown all work without it, and every caller treats `null` as "city search
 * is unavailable" and says so. Returning a rejected promise here would surface
 * as an unhandled rejection in a component that simply renders a ZIP column.
 */
export function loadPlaceIndex(signal?: AbortSignal): Promise<PlaceIndex | null> {
  if (cached) return cached
  cached = (async () => {
    try {
      const res = await fetch(ZCTA_PLACES_URL, signal ? { signal } : undefined)
      if (!res.ok) {
        console.warn(`CivicScope: place mapping unavailable (HTTP ${res.status}); city search is off`)
        return null
      }
      const { byZip, places } = decodePlaces(await res.json())
      return new PlaceIndex(byZip, places)
    } catch (err) {
      console.warn('CivicScope: place mapping could not be loaded; city search is off', err)
      return null
    }
  })()
  return cached
}

/** Test seam: drops the cached promise so a test can load a different payload. */
export function resetPlaceIndexCache(): void {
  cached = null
}
