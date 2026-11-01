/**
 * Chunked country-wide sweep.
 *
 * Why this exists, measured against the live Census API on 2026-09-29:
 *
 *   33,791 ZCTAs x 14 variables, one request   -> 49-121s, frequently times out
 *   1,000 ZCTAs x 4 variables, one request      -> 1.1s, 998 rows, 45KB
 *   1,500 ZCTAs, one request                     -> HTTP 400
 *
 * The API caps at roughly 1,000 geographies per request, and its latency scales
 * with both row count and variable count. The previous design asked for 33x the
 * row ceiling in a single call, which is why the country-wide screen failed.
 *
 * Two further facts, both found by bisecting against the live service:
 *
 *   - ZCTA values must NOT be quoted. `for=zip code tabulation area:'78701'`
 *     returns HTTP 400; the unquoted form returns rows.
 *   - Failure is often HTTP 200 with an HTML error page. Every response is
 *     therefore validated by shape, never by status code.
 *
 * The sweep is partitioned by numeric ZIP range using TIGERweb, which supports
 * range filters and needs no key, so the partition is free and keyless.
 */

import { fetchResilient } from '../http'
import { isFresh, readCache, writeCache } from '../cache'
import { paced } from '../ratelimit'

const ZCTA_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

/**
 * Maximum ZIP codes per request.
 *
 * Determined empirically against the live API on 2026-09-29, because the
 * obvious assumption is wrong. It is the **URL length**, not the row count,
 * that the API rejects:
 *
 *     800 ZCTAs   6,542 char URL   HTTP 200  800 rows
 *     900 ZCTAs   7,342 char URL   HTTP 200  900 rows
 *     950 ZCTAs   7,742 char URL   HTTP 500
 *   1,000 ZCTAs   8,142 char URL   HTTP 400
 *
 * An earlier version assumed a 1,000-geography ceiling, which held for short
 * numeric ranges and failed for real ZIP lists once the geography string grew.
 * The safe value leaves headroom below the observed limit, because the limit is
 * not documented anywhere and may vary with the query shape.
 */
export const CHUNK_SIZE = 800

/**
 * Hard cap on the encoded geography string.
 *
 * Enforced before the request rather than discovered as a 400, so an
 * over-long chunk is an explicit error instead of a silently empty screen.
 */
export const MAX_GEOGRAPHY_CHARS = 7000

/** TIGERweb page size for enumerating the national ZCTA list. */
const ENUM_PAGE = 20000

/**
 * Numeric windows covering 00000-99950. ZCTAs are dense across the whole
 * range, so a small number of wide windows is cheaper than many narrow ones and
 * the only cost is a few empty windows.
 */
const ZCTA_WINDOWS: [string, string][] = [
  ['00000', '24999'],
  ['25000', '49999'],
  ['50000', '74999'],
  ['75000', '99999'],
]

/**
 * Cache key and lifetime for the enumeration.
 *
 * The key carries a version so that a change to how the list is fetched, or to
 * what counts as a valid code, discards the stored copy. The lifetime is long
 * because the list only changes when Census publishes a new ZCTA layer, which
 * is at most annually.
 */
export const ENUM_CACHE_KEY = 'civicscope://zcta-enumeration/v1'
const ENUM_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Enumerates every ZCTA in the country, keyless, in a handful of requests.
 *
 * Cached, because this used to run on every single page load. It bypasses the
 * request cache by design — it is the partition the sweep is built from, so it
 * cannot depend on a cache that the sweep is about to populate — and that meant
 * every visit re-enumerated all 33,791 codes from TIGERweb in eight requests
 * taking minutes, for a list that changes annually. Storing the finished list
 * means a returning visitor spends nothing and touches no API at all, which is
 * the whole point of the rest of the caching layer.
 */
export async function listAllZctas(signal: AbortSignal): Promise<string[]> {
  const cached = await readCache<string[]>(ENUM_CACHE_KEY)
  if (cached && isFresh(cached, ENUM_TTL_MS) && cached.body.length > 30000) {
    return cached.body
  }

  const all: string[] = []
  for (const [lo, hi] of ZCTA_WINDOWS) {
    const where = encodeURIComponent(`ZCTA5 >= '${lo}' AND ZCTA5 <= '${hi}'`)
    for (let offset = 0; ; offset += ENUM_PAGE) {
      const url = `${ZCTA_LAYER}?where=${where}&outFields=ZCTA5&returnGeometry=false&resultRecordCount=${ENUM_PAGE}&resultOffset=${offset}&f=json`
      const res = await paced(() => fetchResilient(url, { signal, headers: { Accept: 'application/json' } }))
      if (!res.ok) throw new Error(`ZCTA enumeration failed: HTTP ${res.status}`)
      const body = (await res.json()) as { features?: { attributes?: { ZCTA5?: string } }[] }
      const features = body.features ?? []
      for (const f of features) {
        const z = f.attributes?.ZCTA5
        if (typeof z === 'string' && /^\d{5}$/.test(z)) all.push(z)
      }
      if (features.length < ENUM_PAGE) break
    }
  }
  const unique = [...new Set(all)].sort()
  // Only a complete enumeration is worth storing. A short one would be cached
  // as authoritative and quietly shrink the country for ninety days.
  if (unique.length > 30000) {
    await writeCache(ENUM_CACHE_KEY, unique).catch(() => undefined)
  }
  return unique
}

export interface ZctasByPrefix {
  /** ZCTAs whose numeric prefix falls in the first two digits. */
  zip: string
  /** Human name for the group, used for the loading message. */
  label: string
  zctas: string[]
}

const STATE_NAMES: Record<string, string> = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California',
  '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia',
  '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois',
  '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana',
  '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
  '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
  '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma',
  '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina',
  '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont',
  '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin',
  '56': 'Wyoming', '60': 'American Samoa', '66': 'Guam', '69': 'Northern Mariana Islands',
  '72': 'Puerto Rico', '78': 'Virgin Islands', '01 ': 'Alabama',
}

export function stateName(prefix: string): string {
  return STATE_NAMES[prefix] ?? `ZIP prefix ${prefix}`
}

/** Groups ZCTAs by their two-digit USPS prefix, which is the state code. */
export function groupByState(zctas: readonly string[]): ZctasByPrefix[] {
  const groups = new Map<string, string[]>()
  for (const z of zctas) {
    const p = z.slice(0, 2)
    const list = groups.get(p) ?? []
    list.push(z)
    groups.set(p, list)
  }
  return [...groups.entries()]
    .map(([zip, list]) => ({ zip, label: stateName(zip), zctas: list.sort() }))
    .sort((a, b) => Number(a.zip) - Number(b.zip))
}

/**
 * Splits a group of ZCTAs into chunks at or below the measured ceiling.
 *
 * The chunk id is stable and derived from the first and last ZIP, so a cached
 * chunk is still found after a reload even though the chunk boundaries shift
 * when the ZCTA list is re-enumerated.
 */
export function planChunks(zctas: readonly string[], size = CHUNK_SIZE): string[][] {
  const sorted = [...zctas].sort()
  const out: string[][] = []
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size))
  return out
}

/** Stable cache key for a chunk, independent of array position. */
export function chunkKey(zctas: readonly string[]): string {
  return `zcta:${zctas[0]}-${zctas[zctas.length - 1]}:n${zctas.length}`
}

/**
 * Builds the Census geography clause for a chunk.
 *
 * Values are joined unquoted. Quoting them returns HTTP 400, which is the
 * easiest mistake to make here and produces a silently empty result.
 */
export function geographyClause(zctas: readonly string[]): string {
  return `for=${encodeURIComponent(`zip code tabulation area:${zctas.join(',')}`)}`
}

export interface SweepChunkRow {
  zcta: string
  [metric: string]: string | number | null
}

/**
 * Fetches one chunk.
 *
 * The response is validated by shape rather than status. The Census API
 * answers HTTP 200 with an HTML error page for a missing or invalid key, and
 * HTTP 400 for an over-long geography list, so a status-only check reports
 * success for an empty or error payload.
 */
export function fetchChunk(
  zctas: readonly string[],
  vars: readonly string[],
  censusKey: string,
  signal: AbortSignal,
): Promise<{ header: string[]; rows: string[][] }> {
  if (zctas.length === 0) return Promise.resolve({ header: [], rows: [] })
  if (zctas.length > CHUNK_SIZE) {
    return Promise.reject(new Error(`chunk of ${zctas.length} exceeds the safe size of ${CHUNK_SIZE}`))
  }

  const geography = geographyClause(zctas)
  if (geography.length > MAX_GEOGRAPHY_CHARS) {
    // The API's real limit is URL length, so a chunk can be too long even when
    // its row count is fine. Catching it here turns a 400 into a precise error.
    return Promise.reject(
      new Error(
        `chunk geography is ${geography.length} characters, over the ${MAX_GEOGRAPHY_CHARS} limit; ` +
          'split it into smaller pieces',
      ),
    )
  }

  const url = `https://api.census.gov/data/2023/acs/acs5?get=${['NAME', ...vars].join(',')}&${geography}&key=${encodeURIComponent(censusKey)}`

  return (async () => {
    const res = await paced(() => fetchResilient(url, { signal, headers: { Accept: 'application/json' } }))

    // Shape validation first: a 200 can still be an HTML error page, and a 400
    // for an over-long geography arrives as HTML too.
    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? 'error page'
      throw new Error(`Census returned an error page (${res.status}): ${title}`)
    }
    if (!res.ok) throw new Error(`Census HTTP ${res.status} for chunk of ${zctas.length} ZCTAs`)

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('Census returned a response that is not JSON')
    }
    if (!Array.isArray(body) || body.length === 0 || !Array.isArray(body[0])) {
      throw new Error('Census returned an unexpected response shape')
    }

    const header = (body[0] as unknown[]).map(String)
    const rows: string[][] = []
    for (let i = 1; i < body.length; i++) {
      const row = body[i]
      if (Array.isArray(row)) rows.push(row.map((c) => (c === null ? '' : String(c))))
    }
    return { header, rows }
  })()
}
