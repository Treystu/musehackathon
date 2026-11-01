/**
 * Geography resolution.
 *
 * Resolves the Census tract containing the geocoded point and attaches the
 * 11-digit GEOID to the query context, so tract-keyed sources (CDC PLACES)
 * consume geography rather than each re-deriving it.
 *
 * This is a pre-step rather than a plugin on purpose. Plugins communicate
 * through the DAG; this produces a value that belongs on the shared context,
 * and routing it through mutable module state would break the moment two
 * searches run concurrently.
 *
 * Source: the Census TIGERweb ArcGIS service (Census Tracts, layer 8), verified
 * to send Access-Control-Allow-Origin and to require no API key. That is the
 * load-bearing reason tract-level geography works without a Census key: a
 * keyless user still gets authoritative boundaries.
 */

import { getJson } from '../http'
import type { QueryContext, SourceRef } from '../types'

const TIGER_TRACTS =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/8/query'

export const TRACTS_SOURCE: SourceRef = {
  publisher: 'U.S. Census Bureau',
  dataset: 'TIGERweb — Census Tracts',
  tableId: 'GEOID',
  vintage: 'current',
  url: TIGER_TRACTS,
  citation: 'U.S. Census Bureau TIGERweb, Census Tracts layer',
}

interface TigerResponse {
  features?: { attributes: { STATE: string; COUNTY: string; GEOID: string; BASENAME: string } }[]
}

export interface ResolvedTract {
  geoid: string
  state: string
  county: string
  basename: string
}

export async function resolveTract(lat: number, lon: number, signal: AbortSignal): Promise<ResolvedTract | null> {
  const url =
    `${TIGER_TRACTS}?geometry=${lon},${lat}&geometryType=esriGeometryPoint` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GEOID,BASENAME,STATE,COUNTY&returnGeometry=false&f=json`

  try {
    const body = await getJson<TigerResponse>(url, { signal, metered: true })
    const a = body.features?.[0]?.attributes
    if (!a?.GEOID) return null
    // STATE and COUNTY are only present when explicitly requested via
    // outFields, so they are read defensively rather than assumed.
    return {
      geoid: a.GEOID,
      state: a.STATE ?? a.GEOID.slice(0, 2),
      county: a.COUNTY ?? a.GEOID.slice(2, 5),
      basename: a.BASENAME ?? '',
    }
  } catch {
    // A failed geography lookup degrades tract-level data; it must not fail the
    // whole query.
    return null
  }
}

export async function enrichWithTracts(ctx: QueryContext): Promise<ResolvedTract | null> {
  const { lat, lon } = ctx.geo ?? {}
  if (lat === undefined || lon === undefined) return null
  const tract = await resolveTract(lat, lon, ctx.signal)
  if (tract) {
    ctx.tractFips = [tract.geoid]
    // TIGERweb gives us authoritative state and county FIPS, which removes the
    // need to geocode those separately.
    if (ctx.geo) {
      ctx.geo.stateFips = tract.state
      ctx.geo.countyFips = tract.county
    }
  }
  return tract
}
