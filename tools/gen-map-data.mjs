/**
 * Bakes the map's static assets, then does not need to run again.
 *
 * Why this is a committed artefact rather than a runtime fetch:
 *
 *   - ZCTA *polygons* are not an option at all. Rhode Island's 63 ZCTAs alone
 *     are 1.31 MB of geometry, which extrapolates to roughly 700 MB for the
 *     country. A boundary choropleth is impossible for a free static site, so
 *     the map is drawn from one position per ZIP instead.
 *   - The positions are cheap but not free: enumerating all 33,791 centroids
 *     takes about four minutes from TIGERweb. Paying that on every first
 *     visit, to draw a map the visitor may never open, is the wrong trade.
 *   - So the centroids are fetched here once and committed, and the browser
 *     fetches a small file alongside its own cached data.
 *
 * Output:
 *   public/map/zcta-centroids.bin  33,791 (lon, lat) pairs, quantised
 *   public/map/us-states.json      state outlines, simplified
 *   public/map/manifest.json       counts and provenance, asserted in tests
 *
 * Run with: npm run gen:map
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'map')
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer'

/** A 20,000-row page is the largest that survives; 30,000 resets the socket. */
const PAGE = 20000

const log = (...a) => console.log('[gen:map]', ...a)

/**
 * TIGERweb resets connections on large responses and answers HTTP 200 with an
 * error body for a malformed query, so both are treated as retryable here.
 * Build-time only, so a slow fetch is acceptable; a silently short one is not.
 */
async function getJson(url, attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = JSON.parse(text)
      if (body.error) throw new Error(`query error: ${body.message ?? 'unknown'}`)
      return body
    } catch (err) {
      lastErr = err
      const wait = 2000 * (i + 1)
      log(`  retry ${i + 1}/${attempts} after ${err.message}; waiting ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw new Error(`giving up on ${url.slice(0, 120)}: ${lastErr.message}`)
}

/** Every ZCTA with its centroid. ~4 minutes, keyless. */
async function fetchCentroids() {
  log('fetching ZCTA centroids (about 4 minutes, keyless)...')
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${TIGER}/2/query?where=1%3D1&outFields=ZCTA5,CENTLAT,CENTLON` +
      `&returnGeometry=false&resultRecordCount=${PAGE}&resultOffset=${offset}&f=json`
    const body = await getJson(url)
    const features = body.features ?? []
    for (const f of features) {
      const a = f.attributes ?? {}
      const zcta = a.ZCTA5
      const lat = Number(a.CENTLAT)
      const lon = Number(a.CENTLON)
      if (typeof zcta !== 'string' || !/^\d{5}$/.test(zcta)) continue
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      // Deliberately wide. American Samoa and Wake Island sit outside the
      // continental bounds and are real ZCTAs, so a tight box would silently
      // drop territory rather than flag a bad coordinate.
      if (lat < -20 || lat > 75 || lon < -180 || lon > 180) continue
      out.push({ zcta, lat, lon })
    }
    log(`  offset ${offset}: ${features.length} (kept ${out.length})`)
    if (features.length < PAGE) break
  }
  out.sort((a, b) => (a.zcta < b.zcta ? -1 : a.zcta > b.zcta ? 1 : 0))
  return out
}

/**
 * Encodes centroids as varint ZCTA deltas plus quantised 16-bit coordinates.
 *
 * A plain JSON array is 0.8 MB for 33,791 points. Quantising each coordinate to
 * a uint16 over the country's real extent is about six times smaller, and the
 * error is under six metres, far below a ZIP area's own width.
 *
 * The ZCTA codes are stored rather than implied by position. Deriving the nth
 * point's code from its index would attach every point to the wrong ZIP if even
 * one code were ever filtered out, and the map would look correct while being
 * wrong.
 *
 * Layout: uint32 count, then per point a varint delta of (zcta - previous - 1)
 * and two big-endian uint16 coordinates. Mirrored by `encodeCentroids` in
 * src/core/map/centroids.ts, and the two are pinned together in tests.
 */
function packCentroids(points) {
  const LON_MIN = -180
  const LAT_MIN = -20
  const LON_MAX = 180
  const LAT_MAX = 75
  const sx = 65535 / (LON_MAX - LON_MIN)
  const sy = 65535 / (LAT_MAX - LAT_MIN)

  // Interleaved per point: varint delta, then two uint16 coordinates. The
  // reader in src/core/map/centroids.ts decodes in that same order, and the two
  // are pinned against each other by map-data.test.ts.
  const parts = []
  let previous = -1
  for (const p of points) {
    const zcta = Number(p.zcta)
    let value = zcta - previous - 1
    if (value < 0) throw new Error(`ZCTA codes must be ascending and unique: ${p.zcta}`)
    previous = zcta
    do {
      const byte = value & 0x7f
      value >>>= 7
      parts.push(value > 0 ? byte | 0x80 : byte)
    } while (value > 0)
    const lo = Math.max(0, Math.min(65535, Math.round((p.lon - LON_MIN) * sx)))
    const la = Math.max(0, Math.min(65535, Math.round((p.lat - LAT_MIN) * sy)))
    parts.push((lo >> 8) & 0xff, lo & 0xff, (la >> 8) & 0xff, la & 0xff)
  }

  const buffer = Buffer.alloc(4 + parts.length)
  buffer.writeUInt32BE(points.length, 0)
  parts.forEach((b, i) => buffer.writeUInt8(b, 4 + i))
  return buffer
}

/** US state and territory outlines, in small groups because the full query resets. */
async function fetchStates() {
  const CODES = (
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO ' +
    'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ' +
    'DC PR VI GU AS MP'
  ).split(' ')

  // Four at a time: each response stays far below the size that resets, while
  // the whole run still finishes in minutes rather than an hour.
  const GROUP = 4
  const features = []
  for (let i = 0; i < CODES.length; i += GROUP) {
    const group = CODES.slice(i, i + GROUP)
    const where = `STUSAB IN (${group.map((c) => `'${c}'`).join(',')})`
    const url =
      `${TIGER}/80/query?where=${encodeURIComponent(where)}&outFields=STUSAB,BASENAME` +
      `&returnGeometry=true&outSR=4326&geometryPrecision=2&f=geojson`
    const body = await getJson(url)
    for (const f of body.features ?? []) features.push(f)
    log(`  states ${i + group.length}/${CODES.length}: ${features.length} outlines`)
  }
  return features
}

/**
 * Drops points closer together than the simplification tolerance.
 *
 * The outlines are only ever drawn as a background reference at national zoom,
 * so exact coastlines buy nothing while costing most of the bytes.
 *
 * A ring must keep at least four positions and stay closed, because that is
 * what GeoJSON requires and what d3-geo refuses to draw otherwise. Simplifying
 * without this check produced invalid rings that threw at render time, taking
 * the whole page down rather than just the map.
 */
function simplifyRing(ring, tolerance) {
  const out = []
  for (const pt of ring) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - pt[0]) < tolerance && Math.abs(last[1] - pt[1]) < tolerance) continue
    out.push(pt)
  }
  if (out.length < 4) return ring
  const first = out[0]
  const last = out[out.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    out.push([first[0], first[1]])
  }
  return out.length >= 4 ? out : ring
}

function simplifyPolygon(polygon, tolerance) {
  // A ring with fewer than four positions is not drawable, so the polygon is
  // dropped entirely rather than kept in a state that throws when rendered.
  const rings = polygon.map((r) => simplifyRing(r, tolerance)).filter((r) => r.length >= 4)
  return rings.length > 0 ? rings : null
}

function simplifyGeometry(geometry, tolerance) {
  if (geometry.type === 'Polygon') {
    const rings = simplifyPolygon(geometry.coordinates, tolerance)
    return rings ? { type: 'Polygon', coordinates: rings } : null
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates
      .map((poly) => simplifyPolygon(poly, tolerance))
      .filter(Boolean)
    return polygons.length > 0 ? { type: 'MultiPolygon', coordinates: polygons } : null
  }
  return null
}

async function main() {
  if (process.argv.includes('--force') || !existsSync(join(OUT, 'manifest.json'))) {
    mkdirSync(OUT, { recursive: true })

    const points = await fetchCentroids()
    if (points.length < 30000) {
      throw new Error(`only ${points.length} centroids; the country has 33,791 and a short fetch is a bug`)
    }
    const packed = packCentroids(points)
    writeFileSync(join(OUT, 'zcta-centroids.bin'), packed)
    log(`zcta-centroids.bin: ${points.length} points, ${(packed.length / 1024).toFixed(0)} KB`)

    const states = await fetchStates()
    // geometryPrecision=2 is already ~1.1 km; 0.15 deg of extra tolerance on
    // top of that takes the file down without changing what a state looks like.
    const features = []
    for (const f of states) {
      const geometry = simplifyGeometry(f.geometry, 0.15)
      // A state whose outline simplified away entirely is dropped, because a
      // null geometry would throw inside the path renderer and blank the page.
      if (!geometry) {
        log(`  dropped ${f.properties?.STUSAB ?? '?'}: outline simplified away`)
        continue
      }
      features.push({ type: 'Feature', properties: f.properties ?? {}, geometry })
    }
    const simplified = { type: 'FeatureCollection', features }
    const statesJson = JSON.stringify(simplified)
    writeFileSync(join(OUT, 'us-states.json'), statesJson)
    log(`us-states.json: ${simplified.features.length} outlines, ${(statesJson.length / 1024).toFixed(0)} KB`)

    writeFileSync(
      join(OUT, 'manifest.json'),
      JSON.stringify(
        {
          generatedFrom: 'US Census Bureau TIGERweb (tigerWMS_Current)',
          licence: 'Public domain, US Census Bureau',
          zctaCentroids: points.length,
          stateOutlines: simplified.features.length,
          centroidBytes: packed.length,
          statesBytes: statesJson.length,
        },
        null,
        2,
      ) + '\n',
    )
    log('manifest.json written')
  } else {
    log('assets already present; pass --force to regenerate')
  }
}

await main()
