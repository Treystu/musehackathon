/**
 * The baked map assets.
 *
 * A mistake in the centroid format is the worst kind of bug here: the map would
 * render, look plausible, and place homes in the wrong states. These tests
 * therefore pin the packer against the decoder, and check the committed asset
 * against the country it is supposed to describe.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodeCentroids, encodeCentroids, type ZctaPoint } from './centroids'
import { buildBins, binFor, MAP_METRICS, RAMP, THIN_SAMPLE_HOUSEHOLDS } from './scale'
import { hexbin, hexRadius } from './binning'
import { clampScale, createView, fitBase, projectAll, zoomAround, type Basemap, type Viewport } from './projection'

const ROOT = join(__dirname, '..', '..', '..')
const BIN = join(ROOT, 'public', 'map', 'zcta-centroids.bin')
const STATES = join(ROOT, 'public', 'map', 'us-states.json')

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('the centroid format round-trips', () => {
  it('survives a pack and unpack unchanged', () => {
    const points: ZctaPoint[] = [
      { zcta: '00601', lon: -66.1063, lat: 18.4661 },
      { zcta: '78701', lon: -97.7431, lat: 30.2672 },
      { zcta: '99501', lon: -149.9003, lat: 61.2181 },
      { zcta: '99999', lon: 145.7537, lat: -14.28 },
    ]
    const decoded = decodeCentroids(encodeCentroids(points))
    expect(decoded).toHaveLength(points.length)
    // Half a quantisation step is the worst case: 360/65535 of a degree of
    // longitude, and 95/65535 of a degree of latitude. That is about 270 m and
    // 85 m respectively, which is far narrower than the smallest ZIP area, so
    // asserting anything tighter would be asserting an error that does not
    // exist rather than one that does.
    const LON_STEP = 360 / 65535
    const LAT_STEP = 95 / 65535
    for (const original of points) {
      const match = decoded.find((d) => d.zcta === original.zcta)
      expect(match, `no point for ${original.zcta}`).toBeDefined()
      expect(Math.abs(match!.lon - original.lon)).toBeLessThanOrEqual(LON_STEP / 2)
      expect(Math.abs(match!.lat - original.lat)).toBeLessThanOrEqual(LAT_STEP / 2)
    }
  })

  it('keeps codes exact, so a filtered point cannot shift every other ZIP', () => {
    // The bug this guards against: deriving a point's ZIP from its index, which
    // silently mislabels every point after any gap in the sequence.
    const sparse: ZctaPoint[] = [
      { zcta: '16332', lon: -79.3687, lat: 41.3609 },
      { zcta: '99701', lon: -150.6, lat: 64.8 },
    ]
    const decoded = decodeCentroids(encodeCentroids(sparse))
    expect(decoded.map((d) => d.zcta)).toEqual(['16332', '99701'])
  })

  it('reads a truncated file as fewer points rather than throwing', () => {
    const full = encodeCentroids([
      { zcta: '00601', lon: -66.1, lat: 18.4 },
      { zcta: '78701', lon: -97.7, lat: 30.2 },
      { zcta: '99501', lon: -149.9, lat: 61.2 },
    ])
    const decoded = decodeCentroids(full.slice(0, full.byteLength - 4))
    expect(decoded.length).toBeLessThan(3)
  })

  it('treats an empty or absent file as empty, not as an error', () => {
    expect(decodeCentroids(new ArrayBuffer(0))).toEqual([])
    expect(decodeCentroids(new ArrayBuffer(4))).toEqual([])
  })
})

describe('the committed centroid asset describes the real country', () => {
  const points = decodeCentroids(toArrayBuffer(readFileSync(BIN)))

  it('holds every ZCTA the Census publishes', () => {
    expect(points.length).toBe(33791)
  })

  it('has unique, well-formed ZIP codes', () => {
    const seen = new Set(points.map((p) => p.zcta))
    expect(seen.size).toBe(points.length)
    for (const p of points) expect(p.zcta).toMatch(/^\d{5}$/)
  })

  it('places them all in or near the United States and its territories', () => {
    for (const p of points) {
      expect(p.lat, `${p.zcta} latitude`).toBeGreaterThanOrEqual(-20)
      expect(p.lat, `${p.zcta} latitude`).toBeLessThanOrEqual(75)
      expect(p.lon, `${p.zcta} longitude`).toBeGreaterThanOrEqual(-180)
      expect(p.lon, `${p.zcta} longitude`).toBeLessThanOrEqual(180)
    }
  })

  it('gets three check ZIPs into the right states', () => {
    // A handful of places whose coordinates are not in dispute. If a projection
    // or format change moved these, the map is wrong everywhere.
    const at = (zcta: string) => points.find((p) => p.zcta === zcta)
    const austin = at('78701')!
    expect(austin.lat).toBeGreaterThan(29)
    expect(austin.lat).toBeLessThan(32)
    expect(Math.abs(austin.lon + 97.7)).toBeLessThan(1.5)

    const anchorage = at('99501')!
    expect(anchorage.lat).toBeGreaterThan(60)
    expect(anchorage.lon).toBeLessThan(-148)

    const honolulu = at('96813')!
    expect(honolulu.lat).toBeGreaterThan(21)
    expect(honolulu.lat).toBeLessThan(22)
    expect(honolulu.lon).toBeLessThan(-157)
  })
})

describe('the committed basemap', () => {
  interface ParsedGeometry {
    type: string
    coordinates: number[][][] | number[][][][]
  }
  const basemap = JSON.parse(readFileSync(STATES, 'utf8')) as {
    features: {
      properties?: { STUSAB?: string }
      geometry: ParsedGeometry
    }[]
  }

  it('covers the states and territories', () => {
    const codes = new Set(basemap.features.map((f) => f.properties?.STUSAB))
    // 50 states, DC, Puerto Rico and the inhabited territories.
    expect(codes.size).toBeGreaterThanOrEqual(53)
    for (const required of ['CA', 'TX', 'NY', 'FL', 'AK', 'HI', 'PR', 'DC']) {
      expect(codes.has(required), `missing ${required}`).toBe(true)
    }
  })

  it('is drawn as polygons, not as an error payload', () => {
    for (const f of basemap.features) {
      expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type)
    }
  })

  it('has only drawable rings, so the renderer cannot throw', () => {
    // Simplifying an outline can collapse a ring below the four positions
    // GeoJSON requires. d3-geo throws on one of those, which unmounts the
    // whole page rather than just the map, so every ring is checked here.
    const ringsOf = (g: ParsedGeometry): number[][][] => {
      if (g.type === 'Polygon') return g.coordinates as number[][][]
      if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).flat()
      return []
    }
    for (const f of basemap.features) {
      const rings = ringsOf(f.geometry)
      expect(rings.length, `${f.properties?.STUSAB} has no ring`).toBeGreaterThan(0)
      for (const ring of rings) {
        expect(ring.length, `${f.properties?.STUSAB} ring too short`).toBeGreaterThanOrEqual(4)
        const first = ring[0]!
        const last = ring[ring.length - 1]!
        expect(first[0], `${f.properties?.STUSAB} ring is not closed`).toBe(last[0])
        expect(first[1], `${f.properties?.STUSAB} ring is not closed`).toBe(last[1])
        for (const pt of ring) {
          expect(Number.isFinite(pt[0]), `${f.properties?.STUSAB} has a bad x`).toBe(true)
          expect(Number.isFinite(pt[1]), `${f.properties?.STUSAB} has a bad y`).toBe(true)
        }
      }
    }
  })

  it('is actually fed to the path renderer without throwing', () => {
    // The end-to-end version of the check above: build the real path and walk
    // every feature through it. This is what the page actually does.
    const view = createView(
      fitBase([]),
      { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 },
      basemap as unknown as Basemap,
    )
    const commands: string[] = []
    const ctx = {
      save: () => commands.push('save'),
      restore: () => commands.push('restore'),
      transform: () => commands.push('transform'),
      beginPath: () => commands.push('beginPath'),
      closePath: () => commands.push('closePath'),
      moveTo: () => commands.push('moveTo'),
      lineTo: () => commands.push('lineTo'),
      stroke: () => commands.push('stroke'),
      fill: () => commands.push('fill'),
    } as unknown as CanvasRenderingContext2D
    expect(() => view.outlines()(ctx), 'the path renderer threw on the real basemap').not.toThrow()
    expect(commands.length, 'the path renderer drew nothing').toBeGreaterThan(0)
  })
})

describe('the colour scale', () => {
  it('produces one bin per ramp step with real boundaries', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 1)
    const bins = buildBins(values)
    expect(bins).toHaveLength(RAMP.length)
    expect(bins[0]!.from).toBe(1)
    expect(bins[bins.length - 1]!.to).toBeNull()
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i]!.from).toBeGreaterThanOrEqual(bins[i - 1]!.from)
    }
  })

  it('assigns every real value to exactly one bin', () => {
    const values = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 4800)
    const bins = buildBins(values)
    for (const v of [0, 1, 25, 2400, 4799]) {
      expect(binFor(bins, v), `no bin for ${v}`).not.toBeNull()
    }
  })

  it('never assigns a bin to a missing or impossible value', () => {
    const bins = buildBins([10, 20, 30, 40])
    expect(binFor(bins, null)).toBeNull()
    expect(binFor(bins, undefined)).toBeNull()
    expect(binFor(bins, Number.NaN)).toBeNull()
    expect(binFor(bins, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('builds contiguous bands, so every colour is used and the legend is true', () => {
    // The first band took its lower edge from the minimum and its upper edge
    // from the first quantile, which is the same number, so the lightest colour
    // was a zero-width band no value could ever land in and the second band
    // inherited the real lower bound. On a real map the legend opened
    // "0.2x to 0.2x" and then "0.2x to 1.7x", describing a range that does not
    // exist and leaving the palest colour unused across the whole country.
    const values = Array.from({ length: 5000 }, (_, i) => (i * 37) % 1200)
    const bins = buildBins(values)

    for (let i = 1; i < bins.length; i++) {
      expect(bins[i]!.from, `band ${i} does not start where band ${i - 1} ends`).toBe(bins[i - 1]!.to)
    }
    // No band may be empty, which is what killed the lightest colour.
    for (const [i, b] of bins.entries()) {
      if (b.to === null) continue
      expect(b.to, `band ${i} is zero-width`).toBeGreaterThan(b.from)
    }
    // And every value must land in exactly one band, so no colour goes unused.
    const used = new Set(values.map((v) => bins.findIndex((b) => binFor(bins, v) === b)))
    expect(used.size, `${bins.length - used.size} band(s) are never used`).toBe(bins.length)
  })

  it('publishes a derived figure everywhere it can be computed', () => {
    // A floor of 500 households used to apply here. The reasoning was sound and
    // the outcome was not: it greyed out 438 of 1,412 areas on the
    // price-to-income map, and a reader cannot tell "we are withholding this"
    // from "there is nothing here". It was the app's own decision presented as a
    // fact about the place. The figure is shown, and a thin sample is marked
    // rather than hidden.
    //
    // The underlying caution still holds and is why THIN_SAMPLE_HOUSEHOLDS
    // exists: an ACS median over a few dozen households is dominated by one
    // family, so the ratio swings. That is a reason to mark it, not to hide it.
    const priceToIncome = MAP_METRICS.find((m) => m.key === 'price_to_income')!
    const thin = { median_home_value: 55900, median_household_income: 112864, households: 351 }
    const solid = { median_home_value: 653600, median_household_income: 154867, households: 8021 }
    // Real, measured rows from the live endpoint: both are now published.
    expect(priceToIncome.derive!(thin), 'a real 351-household figure was withheld').toBeCloseTo(
      55900 / 112864,
      6,
    )
    expect(priceToIncome.derive!(solid)).toBeCloseTo(653600 / 154867, 6)
    // Every thin case the audit found is published rather than withheld.
    for (const hh of [34, 102, 113, 159, 348, 351]) {
      expect(
        priceToIncome.derive!({ ...thin, households: hh }),
        `a real ${hh}-household figure was withheld`,
      ).toBeCloseTo(55900 / 112864, 6)
    }
    // And the thin-sample threshold is a mark, not a cut.
    expect(THIN_SAMPLE_HOUSEHOLDS).toBeGreaterThan(0)
    expect(priceToIncome.derive!({ ...thin, households: 1366 })).toBeCloseTo(55900 / 112864, 6)
    // A genuinely missing input is still not published.
    expect(priceToIncome.derive!({ median_home_value: 300000, median_household_income: 60000 })).toBeNull()
    expect(priceToIncome.derive!({ median_home_value: null, median_household_income: 60000 })).toBeNull()
  })

  it('shows every figure the sweep can actually supply', () => {
    // A metric the sweep never fetches would render an empty map while looking
    // broken, so every plain key must be a real cached column, and every derived
    // key must declare how it is formed.
    const cached = [
      'median_gross_rent',
      'median_rent_burden_pct',
      'median_home_value',
      'median_household_income',
      'households',
    ]
    for (const m of MAP_METRICS) {
      if (m.derive) {
        expect(m.blurb.length, `${m.key} needs a blurb`).toBeGreaterThan(20)
        continue
      }
      expect(cached, `${m.key} is not a figure the sweep fetches`).toContain(m.key)
    }
    // Every cached figure the map offers should be on it, or the map is
    // withholding something the data already holds.
    for (const key of cached) {
      expect(MAP_METRICS.map((m) => m.key), `${key} is cached but not mappable`).toContain(key)
    }
  })

  it('forms every derived figure only from figures it actually holds', () => {
    const base = {
      median_home_value: 300000,
      median_household_income: 60000,
      median_gross_rent: 1400,
      median_rent_burden_pct: 28,
      households: 900,
    }
    const priceToIncome = MAP_METRICS.find((m) => m.key === 'price_to_income')!
    // 300,000 on 60,000 is five times, and the label says five times.
    expect(priceToIncome.derive!(base)).toBeCloseTo(5, 6)
    const rentToIncome = MAP_METRICS.find((m) => m.key === 'rent_to_income')!
    expect(rentToIncome.derive!(base)).toBeCloseTo((1400 * 12) / 60000, 6)
    // A ratio that cannot be formed is null, never a guess and never a zero,
    // so it renders as not yet imported exactly like a missing estimate.
    expect(priceToIncome.derive!({ ...base, median_home_value: null })).toBeNull()
    expect(priceToIncome.derive!({ ...base, median_household_income: 0 })).toBeNull()
    expect(rentToIncome.derive!({ ...base, median_gross_rent: undefined as never })).toBeNull()
  })

  it('never offers a question the colour scale would answer backwards', () => {
    // The map used to carry a row of plain questions, including "where is rent
    // cheapest?", and paint the darkest areas where rent is HIGHEST, because the
    // ramp darkens toward higher values for every figure. A reader who took the
    // chip at face value got the exact opposite of the answer.
    //
    // There is now one control rather than two, and it says which way darker
    // reads before the reader has to work it out.
    const view = readFileSync(join(__dirname, '..', '..', 'ui', 'MapView.tsx'), 'utf8')
    expect(view, 'the duplicate question control must be gone').not.toMatch(
      /What people usually want to know/,
    )
    expect(view, 'the control must state the direction').toMatch(/darker = higher/)
    expect(view, 'the control must say what the colours mean').toMatch(/What the colour shows/)

    // Every figure must declare a direction the ramp can honour, and explain
    // itself for hover rather than only in a list.
    for (const m of MAP_METRICS) {
      expect(['lower', 'higher'], `${m.key} has no direction`).toContain(m.betterWhen)
      expect(m.blurb.length, `${m.key} needs an explanation`).toBeGreaterThan(40)
      expect(m.blurb.toLowerCase(), `${m.key} must say which way darker reads`).toMatch(/darker/)
    }
  })
})

const points = [
    { zcta: '78701', lon: -97.7431, lat: 30.2672 },
    { zcta: '10001', lon: -74.006, lat: 40.7128 },
    { zcta: '99501', lon: -149.9003, lat: 61.2181 },
    { zcta: '96813', lon: -157.8583, lat: 21.3069 },
    { zcta: '00601', lon: -66.1063, lat: 18.4661 },
]

describe('the projection', () => {

  it('places every point on the canvas, whatever the canvas size', () => {
    // A fresh d3 projection clips to 960x500. Anything wider silently dropped
    // points, so the map rendered blank on a common screen size while every
    // unit test still passed.
    for (const [w, h] of [
      [900, 560],
      [1248, 614],
      [1600, 900],
      [320, 240],
    ] as const) {
      const view = createView(fitBase(points), { width: w, height: h, scale: 1, offsetX: 0, offsetY: 0 }, null)
      for (const p of points) {
        const at = view.project(p.lon, p.lat)
        expect(at, `${p.zcta} dropped at ${w}x${h}`).not.toBeNull()
        expect(at![0]).toBeGreaterThan(-w)
        expect(at![0]).toBeLessThan(w * 2)
        expect(at![1]).toBeGreaterThan(-h)
        expect(at![1]).toBeLessThan(h * 2)
      }
    }
  })

  it('includes Puerto Rico, which d3 albersUsa clips out', () => {
    // Roughly 150 ZIP codes live in Puerto Rico. A projection of San Juan
    // returns null under albersUsa, so without an inset of its own they vanish
    // from the map while still being listed in the table.
    const view = createView(fitBase(points), { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 }, null)
    const sanJuan = view.project(-66.1063, 18.4661)
    expect(sanJuan, 'Puerto Rico was dropped from the map').not.toBeNull()
    // It must land in the inset, away from the mainland, or it would be drawn
    // in the Gulf.
    const austin = view.project(-97.7431, 30.2672)!
    expect(Math.abs(sanJuan![0] - austin[0]) + Math.abs(sanJuan![1] - austin[1])).toBeGreaterThan(50)
  })

  it('keeps the mainland and the Alaska and Hawaii insets apart', () => {
    // geoAlbersUsa draws AK and HI as inset boxes. If a change dropped that,
    // they would sit thousands of miles from the mainland and the map would be
    // geographically wrong in a way no arithmetic test would describe.
    const view = createView(fitBase(points), { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 }, null)
    const austin = view.project(-97.7431, 30.2672)!
    const anchorage = view.project(-149.9003, 61.2181)!
    const honolulu = view.project(-157.8583, 21.3069)!
    expect(anchorage[0], 'Alaska should be inset west of the mainland').toBeLessThan(austin[0])
    expect(honolulu[0], 'Hawaii should be inset west of the mainland').toBeLessThan(austin[0])
  })

  it('moves points and outlines together as the viewport changes', () => {
    // If zoom were applied to the points but not the basemap, the outlines
    // would slide out from under the data at the first zoom.
    const before = createView(fitBase(points), { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 }, null)
    const after = createView(fitBase(points), { width: 900, height: 560, scale: 3, offsetX: 40, offsetY: 20 }, null)
    const a = before.project(-97.7431, 30.2672)!
    const b = after.project(-97.7431, 30.2672)!
    expect(b[0]).not.toBeCloseTo(a[0], 3)
    expect(b[1]).not.toBeCloseTo(a[1], 3)
  })

  it('returns nothing for a coordinate it cannot place', () => {
    const view = createView(fitBase(points), { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 }, null)
    // Null rather than (0, 0), so a corrupt coordinate cannot be mistaken for
    // a real place at the map's origin.
    expect(view.project(0, 0)).toBeNull()
  })

  it('keeps the anchor point itself fixed while zooming', () => {
    // Zooming magnifies distances from the anchor; only the anchor stays put.
    // The first version of this test asserted that a point's *distance* from
    // the anchor was unchanged, which would mean the map was not zooming at
    // all. The anchor is taken from a real projected position so it is a point
    // that genuinely exists on the map.
    const dims = { width: 1200, height: 700 }
    const start: Viewport = { ...dims, scale: 1, offsetX: 0, offsetY: 0 }
    const view0 = createView(fitBase(points), start, null)
    const anchorPoint = points[1]!
    const anchor = view0.project(anchorPoint.lon, anchorPoint.lat)!
    // zoomAround takes the anchor measured from the centre of the canvas.
    const m = { mx: anchor[0] - dims.width / 2, my: anchor[1] - dims.height / 2 }

    let v = start
    for (let i = 0; i < 4; i++) v = zoomAround(v, 1.5, m.mx, m.my)
    const after = createView(fitBase(points), v, null).project(anchorPoint.lon, anchorPoint.lat)!

    expect(after[0], 'the anchor drifted horizontally').toBeCloseTo(anchor[0], 6)
    expect(after[1], 'the anchor drifted vertically').toBeCloseTo(anchor[1], 6)
  })

  it('magnifies about the anchor rather than about the origin', () => {
    const dims = { width: 1200, height: 700 }
    const start: Viewport = { ...dims, scale: 1, offsetX: 0, offsetY: 0 }
    const view0 = createView(fitBase(points), start, null)
    const a = points[1]!
    const b = points[0]!
    const pa = view0.project(a.lon, a.lat)!
    const pb = view0.project(b.lon, b.lat)!
    const before = Math.hypot(pa[0] - pb[0], pa[1] - pb[1])

    // Zoom three times about a, then a must still be where it was and the gap
    // between a and b must have grown by exactly the zoom factor.
    let v = start
    for (let i = 0; i < 3; i++) v = zoomAround(v, 1.5, pa[0] - dims.width / 2, pa[1] - dims.height / 2)
    const view1 = createView(fitBase(points), v, null)
    const qa = view1.project(a.lon, a.lat)!
    const qb = view1.project(b.lon, b.lat)!

    expect(Math.hypot(qa[0] - pb[0], qa[1] - pb[1])).toBeCloseTo(before, 6)
    expect(Math.hypot(qa[0] - qb[0], qa[1] - qb[1]) / before).toBeCloseTo(v.scale, 4)
  })

  it('keeps data on screen at every zoom step', () => {
    // Uses the real committed centroids rather than five scattered cities:
    // five points cannot tell a blank map from a map legitimately zoomed into
    // empty ocean, and that distinction is the whole regression.
    const real = decodeCentroids(
      readFileSync(join(__dirname, '..', '..', '..', 'public', 'map', 'zcta-centroids.bin')).buffer.slice(
        readFileSync(join(__dirname, '..', '..', '..', 'public', 'map', 'zcta-centroids.bin')).byteOffset,
        readFileSync(join(__dirname, '..', '..', '..', 'public', 'map', 'zcta-centroids.bin')).byteOffset +
          readFileSync(join(__dirname, '..', '..', '..', 'public', 'map', 'zcta-centroids.bin')).byteLength,
      ) as ArrayBuffer,
    )
    const dims = { width: 1200, height: 700 }
    const fit = fitBase(real)
    for (const scale of [1, 1.5, 2.25, 3.375, 5.06, 7.59, 11.4, 17.1, 25.6]) {
      const drawn = createView(fit, { ...dims, scale, offsetX: 0, offsetY: 0 }, null)
      let on = 0
      for (const p of real) {
        const at = drawn.project(p.lon, p.lat)
        if (at && at[0] >= 0 && at[0] <= dims.width && at[1] >= 0 && at[1] <= dims.height) on++
      }
      expect(on, `no ZIP codes on screen at ${scale}x`).toBeGreaterThan(0)
    }
  })
})

describe('the map can show real per-ZIP values, not only summaries', () => {
  /*
   * The objection Jev raised after the accuracy review: a hexagon's median is a
   * derived figure that exists nowhere in the data, so however carefully it is
   * labelled, a map of real data should be able to reach a depth where what it
   * draws is a real ZIP code's published value and nothing else. These tests
   * assert that depth is actually reachable, because it is easy to clamp the
   * zoom back to a comfortable looking limit and never notice.
   */
  const binsAt = (scale: number) => {
    const dims = { width: 1200, height: 700 }
    const view = createView(fitBase(points), { ...dims, scale, offsetX: 0, offsetY: 0 }, null)
    return hexbin(
      points.map((p) => ({ x: view.project(p.lon, p.lat)![0], y: view.project(p.lon, p.lat)![1], value: 10, zctas: [p.zcta] })),
      hexRadius(scale),
    )
  }

  it('resolves every ZIP to its own hexagon when zoomed far enough', () => {
    const deepest = binsAt(clampScale(1000))
    const total = deepest.reduce((n, b) => n + b.count, 0)
    expect(total, 'some ZIP codes vanished at the deepest zoom').toBe(points.length)
    // Every cell a given point falls in must be that point alone.
    expect(
      deepest.filter((b) => b.count > 1).length,
      'hexagons still merge ZIP codes at the deepest zoom, so no value shown is a real single ZIP figure',
    ).toBe(0)
  })

  it('keeps hexagons large enough to letter at that depth', () => {
    expect(hexRadius(clampScale(1000))).toBeGreaterThanOrEqual(11)
  })
})

describe('the map must sit still and move cheaply', () => {
  const viewSrc = () => readFileSync(join(__dirname, '..', '..', 'ui', 'MapView.tsx'), 'utf8')
  const projSrc = () => readFileSync(join(__dirname, 'projection.ts'), 'utf8')

  it('does not write the canvas displayed size from state', () => {
    // Regression: the map grew about fourteen pixels on every frame, forever.
    // The wrapper's height is whatever the canvas makes it, so writing the
    // canvas height from the viewport and then measuring the wrapper height is
    // a feedback loop. It pushed everything below the map down the page and
    // repainted about twenty-two thousand times a second while idle. Nothing
    // caught it: the map rendered correctly, it simply would not sit still,
    // and every test that looked at output rather than at motion passed.
    // The displayed size now belongs to CSS alone.
    expect(viewSrc(), 'the canvas displayed size is being written from state').not.toMatch(
      /canvas\.style\.(width|height)/,
    )
    // The backing store is only assigned when it differs, because assigning it
    // clears the canvas and would force a full repaint on every pass.
    expect(viewSrc(), 'the backing store must only be resized when it changes').toMatch(
      /if \(canvas\.width !== backingW\)/,
    )
  })

  it('projects the country once rather than on every frame', () => {
    // Regression: 33,791 projections were redone on every pan and zoom frame,
    // which cost about a second per zoom click. The projection is deliberately
    // held at its fitted scale with zoom applied afterwards, so its output
    // never changes with the viewport and is computed once into flat arrays.
    expect(projSrc(), 'projectAll must exist to project once').toMatch(/export function projectAll/)
    expect(viewSrc(), 'the frame path must use the cached projection').toMatch(/projectAll/)
    expect(viewSrc(), 'the frame path must apply the screen transform itself').toMatch(/screenTransform/)
    // And the basemap is traced once into a Path2D rather than re-walked
    // through the path builder on every repaint.
    expect(projSrc(), 'the basemap must be traced once into a Path2D').toMatch(/new Path2D\(\)/)
  })
it('routes Puerto Rico through its own projection when projecting once', () => {
    // Regression: the batch projection used only the mainland projection, and
    // albersUsa returns null for Puerto Rico, so all of its ZIP codes silently
    // stopped rendering. A missing map area reads as missing data rather than
    // as a routing mistake, which is exactly why it needs a test.
    const fit = fitBase(points)
    const projected = projectAll(fit, points)
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      expect(projected.ok[i], `${p.zcta} was not projected`).toBe(1)
    }
    // And Puerto Rico must land in its inset, away from the mainland.
    const pr = projected.xs[points.findIndex((p) => p.zcta === '00601')]!
    const mainland = projected.xs[points.findIndex((p) => p.zcta === '78701')]!
    expect(Math.abs(pr - mainland), 'Puerto Rico was placed on the mainland').toBeGreaterThan(50)
  })
})

describe('every step of the ramp must be visible', () => {
  it('never puts a step so close to white that a hexagon disappears', () => {
    // Widening the ramp to ten steps pushed the palest one to #eff6ff, which is
    // indistinguishable from the page. ZIP 84513 sat in the cache the whole time
    // with every figure present, drawn in a colour nobody could see, and read as
    // a hole in the map. Every step has to be visibly a colour.
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const ch = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
    }
    const lightest = Math.max(...RAMP.map(luminance))
    expect(lightest, 'the palest step is indistinguishable from the background').toBeLessThan(0.82)
    for (let i = 1; i < RAMP.length; i++) {
      const gap = Math.abs(luminance(RAMP[i - 1]!) - luminance(RAMP[i]!))
      expect(gap, `steps ${i - 1} and ${i} are indistinguishable`).toBeGreaterThan(0.012)
    }
  })
})

describe('hexagon sizing', () => {
  it('grows with zoom, so zooming in resolves finer detail', () => {
    // A constant radius is what made the first version feel unfinished:
    // magnifying the projection enlarged the country but left every hexagon at
    // nine pixels, so the extra zoom bought nothing.
    expect(hexRadius(4)).toBeGreaterThan(hexRadius(1))
    expect(hexRadius(16)).toBeGreaterThan(hexRadius(4))
  })

  it('never shrinks below the size a label and a hit target need', () => {
    // Too small and the fill vanishes between neighbours, a tooltip cannot be
    // hit and a label cannot be read. There is deliberately no upper bound:
    // capping it was what stopped the map reaching a depth where a hexagon held
    // a single ZIP code, which is the depth at which the value on screen is a
    // real published figure rather than a median across several.
    expect(hexRadius(1)).toBeGreaterThanOrEqual(5)
    expect(hexRadius(0.001)).toBeGreaterThanOrEqual(5)
  })
})

describe('hexbinning', () => {
  it('groups nearby points and reports the median, not the mean', () => {
    // 1 and 2 sit together; 1000 alone. A mean over the group would be ~334,
    // which would misstate a neighbourhood dominated by two ordinary homes.
    const bins = hexbin([
      { x: 10, y: 10, value: 1, zctas: ['00001'] },
      { x: 11, y: 10, value: 2, zctas: ['00002'] },
      { x: 400, y: 400, value: 1000, zctas: ['00003'] },
    ])
    const small = bins.find((b) => b.zctas.includes('00001'))!
    expect(small.count).toBe(2)
    expect(small.value).toBe(1.5)
    expect(bins.find((b) => b.zctas.includes('00003'))!.value).toBe(1000)
  })

  it('keeps a group whose members all lack a figure', () => {
    // Dropping it would make "no data" and "not there" indistinguishable, which
    // is exactly the confusion this app exists to avoid.
    const bins = hexbin([{ x: 10, y: 10, value: Number.NaN, zctas: ['00001'] }])
    expect(bins).toHaveLength(1)
    expect(bins[0]!.value).toBeNull()
  })

  it('reports a median from whatever has loaded, and marks what has not', () => {
    // Requiring every ZIP to have a figure greyed roughly six cells in seven,
    // because a hexagon holds about eighteen ZIP codes and one gap was enough.
    // Requiring none would let a single rural ZIP speak for twenty neighbours.
    const four = (values: number[]) =>
      hexbin([
        { x: 10, y: 10, value: values[0]!, zctas: ['00001'] },
        { x: 11, y: 10, value: values[1]!, zctas: ['00002'] },
        { x: 12, y: 10, value: values[2]!, zctas: ['00003'] },
        { x: 13, y: 10, value: values[3]!, zctas: ['00004'] },
      ])[0]!

    const half = four([10, 20, Number.NaN, Number.NaN])
    expect(half.value, 'half loaded should still report').toBe(15)
    expect(half.withValue).toBe(2)
    expect(half.count).toBe(4)

    // A quarter used to be greyed out. It is now reported from what has loaded,
    // because suppressing it hid data that was genuinely there and a reader
    // could not tell a sparse area from one still loading.
    const under = four([10, Number.NaN, Number.NaN, Number.NaN])
    expect(under.value, 'a partly loaded cell was greyed out').toBe(10)
    expect(under.withValue).toBe(1)
    expect(under.count).toBe(4)
    // The count of what was missing is still reported, so the cell is auditable.
    expect(under.count).toBe(4)
  })

  it('assigns every ZIP to exactly one hexagon', () => {
    const inputs = Array.from({ length: 500 }, (_, i) => ({
      x: (i % 25) * 9,
      y: Math.floor(i / 25) * 9,
      value: i,
      zctas: [String(i).padStart(5, '0')],
    }))
    const seen = hexbin(inputs).flatMap((b) => b.zctas)
    expect(seen).toHaveLength(500)
    expect(new Set(seen).size).toBe(500)
  })
})

describe('zoom bounds', () => {
  it('clamps so the map cannot be zoomed into an unreadable block or out of frame', () => {
    expect(clampScale(0.01)).toBe(1)
    expect(clampScale(1)).toBe(1)
    expect(clampScale(4)).toBe(4)
    // Deep enough for the hexagons to separate into individual ZIP codes, and
    // no deeper, because past that a country-wide dataset is being used to look
    // at a few city blocks.
    expect(clampScale(100000)).toBe(90)
  })
})
