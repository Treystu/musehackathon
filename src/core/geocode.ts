/**
 * Geocoding.
 *
 * Design note, learned the hard way.
 *
 * The original implementation geocoded through Photon, a public OSM service.
 * A 370-ZIP audit exhausted its request budget and it refused connections
 * afterwards. Because rate limits are per-IP, that failure mode applies to every
 * visitor of the deployed site too, not just to the build machine. A free
 * public geocoder is not a safe dependency for a public utility.
 *
 * The replacement is the US Census Bureau's own TIGERweb service, which:
 *   - resolves a ZIP Code Tabulation Area to a point directly, with no
 *     third-party index and no ambiguity about country;
 *   - is a government service that does not rate-limit consumers the way a
 *     hobby-run OSM instance does;
 *   - sends Access-Control-Allow-Origin, so it works from the browser;
 *   - needs no key.
 *
 * TIGERweb is also already a dependency for tract and school-district
 * boundaries, so this removes a third-party dependency rather than adding one.
 *
 * Photon is retained only as a fallback for free-text place names that are not
 * ZIP codes, and it is never asked a question the Census service answers.
 */

import { getJson } from './http'
import type { ResolvedPlace } from './types'

const TIGER_ZCTA =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

const PHOTON = 'https://photon.komoot.io/api/'

interface ZctaFeature {
  attributes: {
    ZCTA5?: string
    NAME?: string
    CENTLAT?: string
    CENTLON?: string
  }
}

export interface GeocodeOutcome {
  places: ResolvedPlace[]
  /** Set when input looked like a US ZIP but no US record was found. */
  notUsZip?: boolean
}

/** TIGERweb stores coordinates as signed decimal-degree strings. */
function parseCoord(s: string | undefined): number | null {
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Builds an ArcGIS `where` clause for a string equality test.
 *
 * `encodeURIComponent` deliberately leaves apostrophes unescaped, because they
 * are legal in a query string. The Census TIGERweb endpoint does not agree: a
 * literal `'` makes it answer HTTP 200 with `{"error":{"message":"Failed to
 * execute query."}}`, which is indistinguishable from a ZIP that does not
 * exist. Every ZIP appeared to "not resolve" for that reason alone.
 *
 * Escaping the quote as %27 is accepted and returns the feature. This is the
 * single change that made ZIP resolution work at all, and it was found by
 * comparing the two encodings against the live service rather than by reading
 * the code.
 */
function whereEquals(field: string, value: string): string {
  return encodeURIComponent(`${field}='${value}'`).replace(/'/g, '%27')
}

/**
 * Resolves a 5-digit ZIP code to its Census ZCTA centroid.
 *
 * This is the primary path and the only one used for ZIP codes. A ZIP code is
 * a Census construct, so asking the Census Bureau is both more accurate and
 * more durable than asking a general gazetteer that happens to index the same
 * five digits somewhere in the world.
 */
async function resolveZcta(zip: string, signal: AbortSignal): Promise<ResolvedPlace | null> {
  const where = whereEquals('ZCTA5', zip)
  // Only fields that actually exist on this layer may be requested. The layer
  // definition is OID, ZCTA5, GEOID, BASENAME, LSADC, NAME, MTFCC, ZCTA5CC,
  // FUNCSTAT, AREALAND, AREAWATER, STGEOMETRY, CENTLAT, CENTLON, INTPTLAT,
  // INTPTLON, OBJECTID — there is no STUSPS. Asking for a missing field does
  // not return a partial result; it fails the whole query with HTTP 200 and
  // `{"error":{"message":"Failed to execute query."}}`, which is
  // indistinguishable from a ZIP that does not exist. That is why every lookup
  // was reporting "not a US ZIP" before this was found.
  const url =
    `${TIGER_ZCTA}?where=${where}&outFields=ZCTA5,NAME,CENTLAT,CENTLON` +
    `&returnGeometry=false&f=json`

  const body = await getJson<{ features?: ZctaFeature[]; error?: { message?: string } }>(url, { signal })
  if (body.error) {
    throw new Error(`Census geocoder: ${body.error.message ?? 'query failed'}`)
  }
  const a = body.features?.[0]?.attributes
  if (!a?.ZCTA5) return null

  const lat = parseCoord(a.CENTLAT)
  const lon = parseCoord(a.CENTLON)
  if (lat === null || lon === null) return null

  return {
    name: a.NAME?.trim() || `ZIP ${zip}`,
    zip: a.ZCTA5,
    lat,
    lon,
    precise: true,
  }
}

/**
 * Free-text fallback for anything that is not a 5-digit ZIP.
 *
 * Photon is a global gazetteer, so results are filtered to the US by its own
 * country code rather than by a bounding box. A box is the wrong tool: the
 * United States spans both hemispheres (Guam is at 144.8°E) and reaches 13.5°N,
 * so two earlier versions of this filter rejected real US ZIP codes for Hawaii,
 * Alaska, Puerto Rico, and Guam.
 */
async function resolveFreeText(text: string, signal: AbortSignal): Promise<ResolvedPlace[]> {
  const url = `${PHOTON}?q=${encodeURIComponent(text)}&limit=8&lang=en`
  const data = await getJson<{
    features?: {
      geometry: { coordinates: [number, number] }
      properties: {
        name?: string
        city?: string
        county?: string
        state?: string
        countrycode?: string
        osm_key?: string
        osm_value?: string
        postcode?: string
      }
    }[]
  }>(url, { signal, headers: { 'Accept-Language': 'en' } })

  const out: ResolvedPlace[] = []
  for (const f of data.features ?? []) {
    const p = f.properties
    const [lon, lat] = f.geometry.coordinates
    const cc = p.countrycode?.trim().toLowerCase()
    if (cc && cc !== 'us') continue

    const name = p.name?.trim() ?? ''
    const postcode = p.postcode?.split(',')[0]?.trim() ?? ''
    const zip = /^\d{5}/.test(postcode) ? postcode : /^\d{5}/.test(name) ? name.slice(0, 5) : postcode || undefined

    out.push({
      name: name || text,
      zip,
      county: p.county,
      state: p.state,
      lat,
      lon,
      precise: p.osm_value === 'postcode',
    })
  }
  // A postcode feature is a better answer than a city centroid, so order them
  // first; Photon's own ordering is not by country or by kind.
  return out.sort((a, b) => Number(b.precise) - Number(a.precise))
}

export async function geocode(text: string, signal: AbortSignal): Promise<GeocodeOutcome> {
  const q = text.trim()
  if (!q) return { places: [] }

  if (/^\d{5}$/.test(q)) {
    const place = await resolveZcta(q, signal)
    return place ? { places: [place] } : { places: [], notUsZip: true }
  }

  return { places: await resolveFreeText(q, signal) }
}

export function formatPlace(p: ResolvedPlace): string {
  return [p.name, p.county, p.state].filter(Boolean).join(', ')
}
