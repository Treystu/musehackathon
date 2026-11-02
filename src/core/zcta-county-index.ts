/**
 * Which county a ZIP code is in, from a committed Census artefact.
 *
 * The companion to zcta-place-index.ts, with the same reasoning: the
 * mapping is baked at build time (tools/gen-zcta-city-mapping.mjs,
 * from the Census Bureau's 2020 ZCTA-to-county relationship file) and
 * served from `/map/` under an immutable year-long header, so a
 * county lookup costs no request and names nobody's search to a
 * third party.
 *
 * The place artefact carries a county name only as the fallback for
 * the 4,983 ZCTAs with no incorporated place; this artefact carries
 * the assignment for all 33,791 ZCTAs — one county per ZCTA by
 * largest land overlap (AREALAND_PART in the relationship file, the
 * generator's parseCounty rule). That completeness is what a county
 * rollup needs: a county's member ZCTAs are mostly ZCTAs that
 * resolved to a city in the place file, and their county was fetched
 * at generation time and discarded before this artefact existed
 * (the COUNTY FINDING in src/core/ai/answer.ts, measured 2026-11-02).
 *
 * County names are NOT shortened. A place name's legal type is a
 * suffix the Census Bureau appends ("Austin city"); a county name's
 * suffix is the name itself ("Boulder County", "Anchorage
 * Municipality", "Juneau City and Borough"). Stripping it would
 * corrupt exactly the names this file exists to carry, so the
 * published NAMELSAD_COUNTY_20 is the display name, verbatim.
 */
import { decodeZips, EXPECTED_PLACE_COUNT } from './zcta-place-index'

/** A ZIP code resolved to the county that overlaps it most by land. */
export interface CountyRecord {
  zip: string
  /** `NAMELSAD_COUNTY_20` verbatim, e.g. `Boulder County`. */
  censusName: string
  /** Postal abbreviation, e.g. `CO`. */
  state: string
}

/** One distinct county, with every ZIP code assigned to it. */
export interface CountyGroup {
  censusName: string
  state: string
  zips: string[]
}

/** The assignment seam the Answer Layer consumes: county name + state per ZCTA. */
export interface CountyAssignment {
  name: string
  state: string
}

export const ZCTA_COUNTIES_URL = '/map/zcta-counties.json'

/** Every ZCTA in the country — the same universe as the place index. */
export const EXPECTED_COUNTY_COUNT = EXPECTED_PLACE_COUNT

interface RawCounties {
  v: number
  zd: number[]
  names: string[]
  states: string[]
  rec: string
}

/** Characters per record: 5-digit county-name index, 2-digit state index. */
const RECORD_WIDTH = 7

/**
 * Turns the shipped payload into lookups.
 *
 * Throws rather than returning a partial index, for the same reason
 * decodePlaces does: record *k* belongs to the k-th ZIP, so a short
 * or misaligned file would attach every county after the gap to the
 * wrong ZIP code and still render plausibly.
 */
export function decodeCounties(payload: unknown): {
  byZip: Map<string, CountyRecord>
  counties: CountyGroup[]
} {
  const raw = payload as RawCounties
  if (!raw || typeof raw !== 'object') throw new Error('county mapping is not an object')
  if (!Array.isArray(raw.zd) || !Array.isArray(raw.names) || !Array.isArray(raw.states)) {
    throw new Error('county mapping is missing zd/names/states')
  }
  if (typeof raw.rec !== 'string') throw new Error('county mapping is missing rec')

  const zips = decodeZips(raw.zd)
  if (zips.length !== raw.rec.length / RECORD_WIDTH) {
    throw new Error(
      `county mapping is misaligned: ${zips.length} ZIP codes but ${raw.rec.length / RECORD_WIDTH} records`,
    )
  }
  for (let i = 1; i < zips.length; i++) {
    if (zips[i]! <= zips[i - 1]!) throw new Error(`county mapping is not strictly ascending at ${zips[i]}`)
  }
  if (zips.length !== EXPECTED_COUNTY_COUNT) {
    throw new Error(`county mapping holds ${zips.length} ZIP codes; the country has ${EXPECTED_COUNTY_COUNT}`)
  }

  const byZip = new Map<string, CountyRecord>()
  const byCounty = new Map<string, CountyGroup>()

  for (let i = 0; i < zips.length; i++) {
    const record = raw.rec.slice(i * RECORD_WIDTH, i * RECORD_WIDTH + RECORD_WIDTH)
    const name = raw.names[Number(record.slice(0, 5))]
    const state = raw.states[Number(record.slice(5, 7))]
    if (name === undefined || state === undefined) {
      throw new Error(`county mapping record ${i} points outside its dictionaries`)
    }
    const zip = zips[i]!
    byZip.set(zip, { zip, censusName: name, state })

    const key = `${name}|${state}`
    let group = byCounty.get(key)
    if (!group) {
      group = { censusName: name, state, zips: [] }
      byCounty.set(key, group)
    }
    group.zips.push(zip)
  }

  for (const group of byCounty.values()) group.zips.sort()
  const counties = [...byCounty.values()]
  counties.sort(
    (a, b) =>
      a.censusName.localeCompare(b.censusName, 'en') || a.state.localeCompare(b.state, 'en'),
  )
  return { byZip, counties }
}

/** The county index, once loaded. Cheap to query; the parse is the expensive part. */
export class CountyIndex {
  constructor(
    readonly byZip: Map<string, CountyRecord>,
    readonly counties: CountyGroup[],
  ) {}

  /** The county this ZIP code is assigned to, or null if it is not one of the 33,791. */
  lookup(zip: string): CountyRecord | null {
    return this.byZip.get(zip) ?? null
  }

  /** `"Boulder County, CO"`, or null when the ZIP is unknown. */
  label(zip: string): string | null {
    const record = this.byZip.get(zip)
    if (!record) return null
    return `${record.censusName}, ${record.state}`
  }

  /** The aggregation seam: `{ name, state }` for a ZCTA, or null when unknown. */
  assignment(zip: string): CountyAssignment | null {
    const record = this.byZip.get(zip)
    if (!record) return null
    return { name: record.censusName, state: record.state }
  }

  /** Assignments for many ZCTAs at once, as the map county-aggregate.ts consumes. */
  assignmentsFor(zctas: Iterable<string>): Map<string, CountyAssignment> {
    const out = new Map<string, CountyAssignment>()
    for (const zip of zctas) {
      const assignment = this.assignment(zip)
      if (assignment) out.set(zip, assignment)
    }
    return out
  }
}

let cached: Promise<CountyIndex | null> | null = null

/**
 * Loads and caches the mapping.
 *
 * Resolves to `null` rather than rejecting when the file is
 * unreachable, mirroring loadPlaceIndex: a missing county index must
 * not take the page down. Callers treat `null` as "county answers
 * are unavailable" and the Answer Layer reports the county level as
 * unsupported, exactly as it did before the artefact existed.
 */
export function loadCountyIndex(signal?: AbortSignal): Promise<CountyIndex | null> {
  if (cached) return cached
  cached = (async () => {
    try {
      const res = await fetch(ZCTA_COUNTIES_URL, signal ? { signal } : undefined)
      if (!res.ok) {
        console.warn(`CivicScope: county mapping unavailable (HTTP ${res.status}); county answers are off`)
        return null
      }
      const { byZip, counties } = decodeCounties(await res.json())
      return new CountyIndex(byZip, counties)
    } catch (err) {
      console.warn('CivicScope: county mapping could not be loaded; county answers are off', err)
      return null
    }
  })()
  return cached
}

/** Test seam: drops the cached promise so a test can load a different payload. */
export function resetCountyIndexCache(): void {
  cached = null
}
