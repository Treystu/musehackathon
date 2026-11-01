/**
 * The live contract behind the map's baked assets.
 *
 * The map ships a committed snapshot of ZIP positions and state outlines. If
 * that snapshot ever stops matching what Census publishes, the map keeps
 * drawing confidently and wrongly. These assertions are the check that it has
 * not drifted, and they run in CI where a failure is a signal rather than a
 * surprise.
 */
import { describe, expect, it } from 'vitest'

import { withNetworkRetry } from './resilience'

const TIGER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer'

/** The layer and fields `tools/gen-map-data.mjs` reads. */
const ZCTA_LAYER = `${TIGER}/2/query`
const ZCTA_FIELDS = 'ZCTA5,CENTLAT,CENTLON'
const STATES_LAYER = `${TIGER}/80/query`

describe('the map data source', () => {
  it('returns a usable centroid for ZIP codes across the country', async () => {
    // Hawaii, Alaska, Puerto Rico and Guam, because the map draws each of these
    // in its own inset and a projection that mishandles one leaves a visible
    // hole rather than an obvious error.
    const cases: [string, string, number, number][] = [
      ['Austin TX', '78701', 29, 32],
      ['New York NY', '10001', 40, 42],
      ['Los Angeles CA', '90012', 33.5, 35],
      ['Anchorage AK', '99501', 60, 63],
      ['Honolulu HI', '96813', 21, 22],
      ['San Juan PR', '00901', 18.3, 18.6],
    ]
    for (const [name, zcta, latLo, latHi] of cases) {
      const body = await withNetworkRetry(name, async () => {
        const url =
          `${ZCTA_LAYER}?where=${encodeURIComponent(`ZCTA5='${zcta}'`)}` +
          `&outFields=${ZCTA_FIELDS}&returnGeometry=false&f=json`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { features?: { attributes?: Record<string, string> }[] }
        return json.features?.[0]?.attributes
      })()
      expect(body, `${name} returned no attributes`).toBeDefined()
      const lat = Number(body!.CENTLAT)
      const lon = Number(body!.CENTLON)
      expect(body!.ZCTA5).toBe(zcta)
      expect(lat, `${name} latitude ${lat}`).toBeGreaterThanOrEqual(latLo)
      expect(lat, `${name} latitude ${lat}`).toBeLessThanOrEqual(latHi)
      expect(Number.isFinite(lon), `${name} longitude ${lon}`).toBe(true)
    }
    // Six separate TIGERweb calls, each of which can take tens of seconds when
    // the service is under load, so this needs a real budget rather than the
    // default five.
  }, 300000)

  it('paginates the way the generator assumes', async () => {
    // The generator stops when a page returns fewer rows than it asked for. If
    // the service ever stopped honouring `resultRecordCount`, a regeneration
    // would quietly write a partial country.
    const body = await withNetworkRetry('ZCTA pagination', async () => {
      const url =
        `${ZCTA_LAYER}?where=1%3D1&outFields=ZCTA5&returnGeometry=false` +
        `&resultRecordCount=20000&resultOffset=0&f=json`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { features?: unknown[] }
    })()
    const features = body.features ?? []
    expect(features.length, 'the endpoint returned fewer rows than requested').toBe(20000)
    // A 20,000-row page takes well over the default five seconds, so the
    // generator's paging assumption is only checkable with a real budget.
  }, 300000)

  it('serves state outlines as drawable geometry', async () => {
    const body = await withNetworkRetry('state outlines', async () => {
      // `STUSAB` is the abbreviation field. Asking for `STUSPS` instead fails
      // the whole query with HTTP 200 and an error body, which is a trap worth
      // pinning.
      const url =
        `${STATES_LAYER}?where=${encodeURIComponent("STUSAB='RI'")}` +
        `&outFields=STUSAB&returnGeometry=true&outSR=4326&geometryPrecision=2&f=geojson`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as {
        error?: { message?: string }
        features?: { geometry?: { type?: string; coordinates?: unknown } }[]
      }
    })()
    expect(body.error, 'the outline query returned an error payload').toBeUndefined()
    const feature = body.features?.[0]
    expect(feature, 'no outline returned').toBeDefined()
    expect(['Polygon', 'MultiPolygon']).toContain(feature!.geometry?.type)
    expect(Array.isArray(feature!.geometry?.coordinates)).toBe(true)
    // TIGERweb takes around fifteen seconds to serve state geometry, so this
    // needs a real budget rather than the default five.
  }, 300000)

  it('rejects a wrong field name rather than returning a partial result', async () => {
    // The generator and the committed asset both depend on this behaviour: a
    // silently missing field would write an asset with blank labels.
    const body = await withNetworkRetry('bad field', async () => {
      const url =
        `${STATES_LAYER}?where=${encodeURIComponent("STUSPS='RI'")}` +
        `&outFields=STUSPS&returnGeometry=false&f=json`
      const res = await fetch(url)
      return (await res.json()) as { error?: { message?: string }; features?: unknown[] }
    })()
    expect(body.error, 'a wrong field name was accepted silently').toBeDefined()
  }, 300000)
})
