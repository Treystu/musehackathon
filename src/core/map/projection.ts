/**
 * The map's projection and the geometry loader.
 *
 * `geoAlbersUsa` from d3-geo is used rather than a hand-rolled projection. It is
 * the standard US equal-area projection, and unlike a plain Mercator it draws
 * Alaska, Hawaii and Puerto Rico as inset boxes instead of dragging them
 * thousands of miles off-canvas. Getting a projection subtly wrong would
 * misplace homes, and nothing else in this app would catch it, so one small
 * dependency is worth paying.
 *
 * The fit is computed here rather than with d3's `fitExtent`, for two reasons.
 * `fitExtent` returns a NaN scale in this build, which would silently blank the
 * map; and doing the arithmetic explicitly lets the fit be computed once and
 * reused, instead of re-projecting 33,791 points on every pan and zoom frame.
 *
 * The projection is fitted into a fixed internal box and then scaled to the
 * canvas. d3's `geoAlbersUsa` clips to 960x500 and exposes no `clipExtent`
 * setter, so fitting straight to a wider canvas would place points outside the
 * clip, where the projection returns null and the map draws nothing.
 */
import { geoAlbersUsa, geoConicEqualArea, geoPath, type GeoProjection } from 'd3-geo'

import { decodeCentroids, type ZctaPoint } from './centroids'

/** Baked asset paths. Same-origin, so no new CSP entry is needed. */
export const CENTROIDS_URL = '/map/zcta-centroids.bin'
export const STATES_URL = '/map/us-states.json'

export interface Basemap {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties?: Record<string, unknown>
    geometry: { type: string; coordinates: unknown }
  }[]
}

export interface Viewport {
  width: number
  height: number
  /** 1 fits the country; higher zooms in. */
  scale: number
  /** Screen-space pan applied after zoom, in pixels. */
  offsetX: number
  offsetY: number
}

export interface MapView {
  /** A d3 projection with this viewport's zoom and pan already composed in. */
  projection: GeoProjection
  /** Projects lon/lat to canvas pixels. Null when the point cannot be placed. */
  project(lon: number, lat: number): [number, number] | null
  /** Path renderer for the basemap outlines at this viewport. */
  outlines(): (ctx: CanvasRenderingContext2D) => void
}

/**
 * Deep enough that a hexagon resolves to a single ZIP code.
 *
 * This is what makes the map faithful rather than merely plausible. At shallow
 * zoom a hexagon covers many ZIP codes and its median is a derived figure that
 * exists nowhere in the data, which is a real thing to object to about a map of
 * real data. Deep enough, each hexagon holds exactly one ZIP code and the value
 * on screen is that ZIP code's published figure, unaltered. Anything shallower
 * than this could only ever be showing a summary.
 *
 * It is reachable now because the zoom buttons target the centroid of what is
 * drawn; the earlier ceiling of 24 was a workaround for buttons that
 * magnified about empty ocean, not a real limit.
 */
const MAX_SCALE = 90

/** The fixed box the country is fitted into, kept inside d3's 960x500 clip. */
const INTERNAL_W = 960
const INTERNAL_H = 500
/** Kept inside the clip so a boundary point is not clipped away. */
const MARGIN = 8

export function clampScale(scale: number): number {
  return Math.max(1, Math.min(MAX_SCALE, scale))
}

export interface BaseFit {
  /** d3's albersUsa, which insets Alaska and Hawaii for us. */
  projection: GeoProjection
  /** Puerto Rico, which d3's albersUsa clips out entirely. */
  pr: GeoProjection
  /** Internal-box scale and translate, i.e. before zoom, pan or canvas fit. */
  k: number
  tx: number
  ty: number
  /** The same for the Puerto Rico inset. */
  prK: number
  prTx: number
  prTy: number
}

/**
 * Puerto Rico, in degrees.
 *
 * d3's `geoAlbersUsa` is documented for the United States including Alaska and
 * Hawaii, and it puts both in inset boxes. It does not include Puerto Rico: a
 * projection of San Juan returns null, so every one of Puerto Rico's roughly
 * 150 ZIP codes would silently disappear from the map while still appearing in
 * the table. It gets its own inset here instead, in the same spirit as d3's.
 */
const PR_BOUNDS = { west: -67.35, east: -65.55, south: 17.85, north: 18.55 }
const PR_BOX = { x: 856, y: 392, w: 96, h: 96 }

function isPuertoRico(lon: number, lat: number): boolean {
  return lon >= PR_BOUNDS.west && lon <= PR_BOUNDS.east && lat >= PR_BOUNDS.south && lat <= PR_BOUNDS.north
}

/** Fits the supplied points into the internal box, centred with a margin. */
function scaleAndCentre(
  projection: GeoProjection,
  points: readonly ZctaPoint[],
  box: { x: number; y: number; w: number; h: number },
  baseScale: number,
  baseT: [number, number],
): { k: number; tx: number; ty: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    const at = projection([p.lon, p.lat])
    // A point the projection cannot place is not part of the extent, so it is
    // skipped rather than poisoning the bounds with NaN.
    if (!at || Number.isNaN(at[0]) || Number.isNaN(at[1])) continue
    if (at[0] < minX) minX = at[0]
    if (at[0] > maxX) maxX = at[0]
    if (at[1] < minY) minY = at[1]
    if (at[1] > maxY) maxY = at[1]
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return { k: baseScale, tx: baseT[0], ty: baseT[1] }
  }
  const k = Math.min(box.w / (maxX - minX), box.h / (maxY - minY))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  // d3 computes screen = scale * projected + translate, so rescaling and
  // re-centring has to carry the base translate through as well. Dropping it
  // shifts the whole country off the canvas, which reads as missing data
  // rather than as a transform mistake.
  return {
    k: baseScale * k,
    tx: box.x + box.w / 2 - k * cx + k * baseT[0],
    ty: box.y + box.h / 2 - k * cy + k * baseT[1],
  }
}

export function fitBase(points: readonly ZctaPoint[]): BaseFit {
  const projection = geoAlbersUsa()
  const baseScale = projection.scale()
  const baseT = projection.translate()

  // A margin inside the clip box, because d3 clips exactly at 960x500 and a
  // point sitting on the boundary is as good as dropped.
  const main = scaleAndCentre(
    projection,
    points,
    { x: MARGIN, y: MARGIN, w: INTERNAL_W - 2 * MARGIN, h: INTERNAL_H - 2 * MARGIN },
    baseScale,
    [baseT[0], baseT[1]],
  )

  const prProjection = geoConicEqualArea().parallels([18, 18])
  const prScale = prProjection.scale()
  const prT = prProjection.translate()
  const prPoints = points.filter((p) => isPuertoRico(p.lon, p.lat))
  const prFit = scaleAndCentre(
    prProjection,
    prPoints,
    PR_BOX,
    prScale,
    [prT[0], prT[1]],
  )

  return {
    projection,
    pr: prProjection,
    k: main.k,
    tx: main.tx,
    ty: main.ty,
    prK: prFit.k,
    prTx: prFit.tx,
    prTy: prFit.ty,
  }
}

/**
 * Composes a fitted base with a viewport.
 *
 * The resulting transform is shared by the points and the basemap, so the
 * outlines cannot slide out from under the data as the viewport changes.
 */
export function createView(
  fit: BaseFit,
  viewport: Viewport,
  basemap: Basemap | null,
): MapView {
  const zoom = clampScale(viewport.scale)
  // Both projections stay at their fitted scale; zoom and pan are applied once,
  // in the screen transform below. Composing zoom into the projection as well
  // applied it twice, so the map magnified by the square of the zoom and had
  // left the canvas entirely by about one and a half times zoom — which is why
  // the first version of this map went blank the moment anyone pressed zoom.
  const projection = geoAlbersUsa()
  projection.scale(fit.k)
  projection.translate([fit.tx, fit.ty])

  const pr = geoConicEqualArea().parallels([18, 18])
  pr.scale(fit.prK)
  pr.translate([fit.prTx, fit.prTy])

  // Scale the internal box up to the canvas, preserving aspect and centring.
  //
  // The centring uses the *zoomed* width, not the unzoomed one. Centring on the
  // unzoomed box anchors zoom at the internal box's top-left corner, so
  // magnifying the map walked the country off the bottom-right and the canvas
  // went blank at about one and a half times zoom. Centring on `s` keeps the
  // box's centre at the canvas's centre for any zoom, which is also what makes
  // an offset of zero mean "centred" at every scale.
  const fitScale = Math.min(viewport.width / INTERNAL_W, viewport.height / INTERNAL_H)
  const s = fitScale * zoom
  const ox = (viewport.width - INTERNAL_W * s) / 2 + viewport.offsetX
  const oy = (viewport.height - INTERNAL_H * s) / 2 + viewport.offsetY

  const place = (p: [number, number] | null): [number, number] | null => {
    // A coordinate the projection cannot place returns null. Keeping that
    // distinct from any real point stops a corrupt centroid from being drawn
    // at (0, 0), where it would look like a genuine place.
    if (!p || Number.isNaN(p[0]) || Number.isNaN(p[1])) return null
    return [p[0] * s + ox, p[1] * s + oy]
  }

  return {
    projection,
    project(lon, lat) {
      return place(isPuertoRico(lon, lat) ? pr([lon, lat]) : projection([lon, lat]))
    },
    outlines() {
      const mainPath = geoPath(projection) as unknown as {
        context: (ctx: CanvasRenderingContext2D) => unknown
      }
      const prPath = geoPath(pr) as unknown as {
        context: (ctx: CanvasRenderingContext2D) => unknown
      }
      return (ctx: CanvasRenderingContext2D) => {
        if (!basemap) return
        // The same transform as `project`, applied to the context rather than
        // to the coordinates, so 33,791 points are never re-projected by hand.
        ctx.save()
        ctx.transform(s, 0, 0, s, ox, oy)

        for (const feature of basemap.features) {
          const inPuertoRico = feature.properties?.STUSAB === 'PR'
          const path = inPuertoRico ? prPath : mainPath
          path.context(ctx)
          ctx.beginPath()
          ;(path as unknown as (f: unknown) => void)(feature)
          ctx.stroke()
        }
        ctx.restore()
      }
    },
  }
}

/**
 * Zooms by `factor` while keeping the canvas point (mx, my) fixed on screen.
 *
 * The arithmetic lives here rather than in the component because it is the same
 * transform the renderer uses: doing it in the view layer means duplicating the
 * fit scale and the centring, which is exactly how a zoom drifts away from what
 * the reader is pointing at.
 */
export function zoomAround(
  viewport: Viewport,
  factor: number,
  mx: number,
  my: number,
): Viewport {
  const target = clampScale(viewport.scale * factor)
  if (target === viewport.scale) return viewport
  const ratio = target / viewport.scale

  // The transform is `screenFromCentre = p * s - (INTERNAL_W * s) / 2 + offset`
  // with `s = fitScale * scale`. Holding a canvas point `m` fixed across a scale
  // change and solving for the offset gives `solve`. Because centring is now on
  // the zoomed box, an offset of zero means centred at every scale, and this
  // reduces to `offset * ratio + m * (1 - ratio)`.
  const solve = (m: number, offset: number) => offset * ratio + m * (1 - ratio)

  return {
    ...viewport,
    scale: target,
    offsetX: solve(mx, viewport.offsetX),
    offsetY: solve(my, viewport.offsetY),
  }
}

/** Loads the baked assets. Same-origin, so the CSP is unaffected. */
export async function loadMapAssets(
  signal?: AbortSignal,
): Promise<{ centroids: ZctaPoint[]; basemap: Basemap | null }> {
  const [centroidResponse, basemapResponse] = await Promise.all([
    fetch(CENTROIDS_URL, signal ? { signal } : undefined),
    // The basemap is context, not data. A failure here must not stop the map
    // from drawing its dots.
    fetch(STATES_URL, signal ? { signal } : undefined).catch(() => null),
  ])
  if (!centroidResponse.ok) {
    throw new Error(`map centroids unavailable: HTTP ${centroidResponse.status}`)
  }
  const centroids = decodeCentroids(await centroidResponse.arrayBuffer())
  let basemap: Basemap | null = null
  if (basemapResponse?.ok) {
    basemap = (await basemapResponse.json()) as Basemap
  }
  return { centroids, basemap }
}

/**
 * Projects every point once, into flat arrays, for a fixed canvas size.
 *
 * The d3 projection is deliberately held at its fitted scale, with zoom and pan
 * applied afterwards in the screen transform. That makes its output for a given
 * lon/lat identical at every zoom level, so the 33,791 projections only ever
 * need doing once. They were being redone on every pan and zoom frame, which is
 * why a single zoom click took about a second.
 *
 * Returns null for points d3 cannot place, so those are skipped rather than
 * being drawn at the origin.
 */
export function projectAll(
  fit: BaseFit,
  points: readonly ZctaPoint[],
): { xs: Float32Array; ys: Float32Array; ok: Uint8Array } {
  const n = points.length
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  const ok = new Uint8Array(n)
  const projection = geoAlbersUsa()
  projection.scale(fit.k)
  projection.translate([fit.tx, fit.ty])
  const pr = geoConicEqualArea().parallels([18, 18])
  pr.scale(fit.prK)
  pr.translate([fit.prTx, fit.prTy])

  for (let i = 0; i < n; i++) {
    const p = points[i]!
    // Puerto Rico goes through its own inset projection, exactly as the
    // per-frame path used to. Using only the mainland projection here silently
    // dropped all of Puerto Rico's ZIP codes, because albersUsa returns null
    // for them — and a missing map area looks like missing data rather than a
    // routing mistake.
    const at = isPuertoRico(p.lon, p.lat) ? pr([p.lon, p.lat]) : projection([p.lon, p.lat])
    if (!at || Number.isNaN(at[0]) || Number.isNaN(at[1])) continue
    xs[i] = at[0]
    ys[i] = at[1]
    ok[i] = 1
  }
  return { xs, ys, ok }
}

/**
 * The scale and offset that turn projected internal coordinates into canvas
 * pixels for a viewport. Separate from `createView` so the per-frame path is
 * two multiplies and two adds rather than a projection call.
 */
export function screenTransform(viewport: Viewport): { s: number; ox: number; oy: number } {
  const zoom = clampScale(viewport.scale)
  const fitScale = Math.min(viewport.width / INTERNAL_W, viewport.height / INTERNAL_H)
  const s = fitScale * zoom
  return {
    s,
    ox: (viewport.width - INTERNAL_W * s) / 2 + viewport.offsetX,
    oy: (viewport.height - INTERNAL_H * s) / 2 + viewport.offsetY,
  }
}

/**
 * The basemap outlines, traced once into a Path2D.
 *
 * `outlines()` re-walked all 56 state outlines through d3's path builder on
 * every repaint, which is a few thousand line segments of work for geometry that
 * does not change between frames. Traced once and re-stroked under the
 * viewport transform, the same basemap costs one `stroke()` call.
 *
 * The returned function closes over the cached path and applies the transform,
 * so the outlines and the data can never drift apart.
 */
export function buildOutlinePath(
  basemap: Basemap | null,
  fit: BaseFit,
): (viewport: Viewport) => (ctx: CanvasRenderingContext2D) => void {
  if (!basemap) return () => () => undefined

  // Two paths, because Puerto Rico is drawn through its own projection and so
  // cannot share the mainland transform. Both are traced once.
  const main = geoAlbersUsa()
  main.scale(fit.k)
  main.translate([fit.tx, fit.ty])
  const pr = geoConicEqualArea().parallels([18, 18])
  pr.scale(fit.prK)
  pr.translate([fit.prTx, fit.prTy])

  const mainPath = new Path2D()
  const prPath = new Path2D()
  for (const feature of basemap.features) {
    const isPuertoRico = feature.properties?.STUSAB === 'PR'
    const projection = isPuertoRico ? pr : main
    const geo = geoPath(projection)(feature as never) as unknown as string
    if (!geo) continue
    if (isPuertoRico) prPath.addPath(new Path2D(geo))
    else mainPath.addPath(new Path2D(geo))
  }

  return (viewport: Viewport) => {
    const { s, ox, oy } = screenTransform(viewport)
    return (ctx: CanvasRenderingContext2D) => {
      ctx.save()
      ctx.transform(s, 0, 0, s, ox, oy)
      ctx.stroke(mainPath)
      ctx.restore()
      ctx.save()
      // Puerto Rico's inset lives inside the same internal box, so the same
      // screen transform applies; only its projection differed.
      ctx.transform(s, 0, 0, s, ox, oy)
      ctx.stroke(prPath)
      ctx.restore()
    }
  }
}
