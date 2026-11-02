/**
 * ResultMap — the map for one verified answer, mounted under the
 * AnswerCard (result-map spec, drive item 13; plan P6).
 *
 * Hand-rolled SVG + the d3-geo projections the shipped map stack
 * already uses (a scoped geoAlbers fit for one area — see scopedFit
 * for why the composite geoAlbersUsa cannot build SVG fills — with
 * the Puerto Rico conic inset routing copied from
 * src/core/map/projection.ts, and fitBase/geoAlbersUsa for the
 * national centroid mode). No tiles, no map library,
 * no new dependency, no new CSP origin: geometry comes from TIGERweb,
 * which the CSP already allows, through the loader in
 * src/core/map/result-geometry.ts (probe-corrected: offset 0.0009
 * DEGREES, cap 25 places, one batched query, 500 KB budget enforced).
 *
 * The rules that make this surface honest:
 *   - Only the answer's VERIFIED places are colored, and every figure
 *     the map emits — legend ends, labels, the place panel — is looked
 *     up from the answer object by place key (figures by reference,
 *     src/core/map/result-scale.ts). Nothing is computed in this layer.
 *   - The map's metric is always one the card itself shows; switching
 *     it re-colors only. The load effect depends on the answer's
 *     place-set, never on the metric, so a switch cannot refetch.
 *   - County answers draw ONE merged outline per county (member ZCTA
 *     geometry combined into a single path carrying the county's
 *     figure); member ZCTAs are never individually colored. A MIXED
 *     answer — an aggregate beside plain places — still draws every
 *     plain place as its own element on top of the aggregate
 *     outlines, with its own figure: the closing battery (cluster C,
 *     case C6, on be13e7e) measured the state-average answer drawing
 *     only the merged outline while its status line claimed 2 places,
 *     leaving Hilo (96720) with no element at all.
 *   - National answers draw area circles by value at the places'
 *     centroids — no state/county/hex geometry carries a value.
 *   - Micro-ZCTAs (building-scale polygons that project to a few
 *     pixels) and places with no published boundary are drawn as
 *     centroid dots and disclosed in words under the map.
 *   - Total geometry failure renders ONE quiet line and no canvas,
 *     no SVG, no empty frame (spec section 4.6).
 *   - Geometry loads lazily, when the map approaches the viewport, so
 *     the card renders fully first and an answer nobody scrolls to
 *     costs no request. Where IntersectionObserver does not exist the
 *     load is offered as an explicit button instead of never firing.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { geoAlbers, geoAlbersUsa, geoCentroid, geoConicEqualArea, geoPath, type GeoProjection } from 'd3-geo'

import type { ComposedAnswer } from '../../core/ai/answer'
import { METRIC_DEFS_BY_KEY } from '../../core/civicscope-registry'
import type { ZctaPoint } from '../../core/map/centroids'
import { fitBase, loadMapAssets, projectAll, type Basemap } from '../../core/map/projection'
import {
  loadCountyOutlineGeometry,
  loadResultGeometry,
  type ResultGeometry,
  type ResultGeometryFeature,
} from '../../core/map/result-geometry'
import {
  colorForValue,
  drivingMetricKey,
  eligibleMetricKeys,
  formatAnswerFigure,
  legendGradientCss,
  legendModel,
  metricLabel,
  nationalCircleRadius,
  orderedResultPlaces,
  overflowPlaceNames,
  resultMapMode,
  resultMapPlaces,
  screeningCoverageLine,
  RESULT_MAP_PLACE_CAP,
  type ResultMapMode,
  type ResultMapPlace,
} from '../../core/map/result-scale'
import { NO_DATA_COLOR } from '../../core/map/scale'
import { formatMetricNumber } from '../metric-format'
import { FairHousingNotice } from '../FairHousingNotice'
import { HelpTip } from '../ai/HelpTip'

/** The internal box the shipped projection stack fits into (projection.ts). */
const INTERNAL_W = 960
const INTERNAL_H = 500
const FIT_BOX = { x: 8, y: 8, w: INTERNAL_W - 16, h: INTERNAL_H - 16 }
const PR_BOUNDS = { west: -67.35, east: -65.55, south: 17.85, north: 18.55 }
const PR_BOX = { x: 856, y: 392, w: 96, h: 96 }
/** Projected area (internal px^2) below which a polygon is a dot, not a shape. */
const MICRO_BOUNDS_AREA = 25

const FAILURE_LINE =
  'The map for this answer could not be loaded. Every figure is in the answer above and the screening table below.'

const HONESTY_LINE =
  'Boundaries: U.S. Census Bureau ZIP Code Tabulation Areas (TIGERweb). ' +
  'A ZCTA is the Census Bureau\u2019s area for a ZIP code \u2014 it is not a USPS delivery boundary. ' +
  'Figures: American Community Survey 2023, as screened for the answer above.'

function isPuertoRico(lon: number, lat: number): boolean {
  return lon >= PR_BOUNDS.west && lon <= PR_BOUNDS.east && lat >= PR_BOUNDS.south && lat <= PR_BOUNDS.north
}

interface ScopedFit {
  pathFor(feature: ResultGeometryFeature): string | null
  project(lon: number, lat: number): [number, number] | null
  boundsFor(feature: ResultGeometryFeature): [[number, number], [number, number]] | null
}

/**
 * Fits a projection to the features' projected bounds inside a box of
 * the internal 960x500 frame — the scaleAndCentre arithmetic from
 * projection.ts, driven by geoPath bounds instead of points, because
 * the scoped set is polygons, not the national centroid cloud.
 */
function fitProjectionToBounds(
  projection: GeoProjection,
  features: readonly ResultGeometryFeature[],
  box: { x: number; y: number; w: number; h: number },
): GeoProjection {
  const baseScale = projection.scale()
  const baseT = projection.translate()
  const path = geoPath(projection)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const feature of features) {
    const b = path.bounds(feature as never)
    if (!Number.isFinite(b[0][0]) || !Number.isFinite(b[1][0])) continue
    minX = Math.min(minX, b[0][0])
    minY = Math.min(minY, b[0][1])
    maxX = Math.max(maxX, b[1][0])
    maxY = Math.max(maxY, b[1][1])
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return projection
  const k = Math.min(box.w / (maxX - minX), box.h / (maxY - minY))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  projection.scale(baseScale * k)
  projection.translate([box.x + box.w / 2 - k * cx + k * baseT[0], box.y + box.h / 2 - k * cy + k * baseT[1]])
  return projection
}

function scopedFit(features: readonly ResultGeometryFeature[]): ScopedFit {
  const mainFeatures: ResultGeometryFeature[] = []
  const prFeatures: ResultGeometryFeature[] = []
  for (const feature of features) {
    const [lon, lat] = geoCentroid(feature as never)
    if (isPuertoRico(lon, lat)) prFeatures.push(feature)
    else mainFeatures.push(feature)
  }
  // A plain geoAlbers rotated to the set's own centroid — NOT
  // geoAlbersUsa. The composite projection prepends its 960x500 clip
  // outline to every path it builds (measured in the result-map e2e:
  // each polygon's path began with the full-frame rectangle), which
  // an SVG fill paints over the whole frame and which then intercepts
  // every hover meant for the polygons under it. A scoped answer is
  // one area, so the national insets buy nothing here; the national
  // mode below still uses fitBase/geoAlbersUsa, where the outlines
  // are strokes on a canvas, not fills.
  const centreOf = (set: readonly ResultGeometryFeature[]): [number, number] => {
    if (set.length === 0) return [-96, 38]
    let lon = 0
    let lat = 0
    for (const f of set) {
      const c = geoCentroid(f as never)
      lon += c[0]
      lat += c[1]
    }
    return [lon / set.length, lat / set.length]
  }
  const [mainLon, mainLat] = centreOf(mainFeatures)
  const main = fitProjectionToBounds(
    geoAlbers()
      .rotate([-mainLon, 0])
      .parallels([Math.max(-80, mainLat - 8), Math.min(80, mainLat + 8)]),
    mainFeatures,
    FIT_BOX,
  )
  // Puerto Rico: its own inset when the mainland is also present (the
  // projection.ts routing), the full frame when the answer is PR alone.
  const pr = fitProjectionToBounds(
    geoConicEqualArea().parallels([18, 18]),
    prFeatures,
    mainFeatures.length > 0 ? PR_BOX : FIT_BOX,
  )
  const forFeature = (feature: ResultGeometryFeature): GeoProjection => {
    const [lon, lat] = geoCentroid(feature as never)
    return isPuertoRico(lon, lat) ? pr : main
  }
  return {
    pathFor(feature) {
      const d = geoPath(forFeature(feature))(feature as never) as unknown as string | null
      return d ?? null
    },
    project(lon, lat) {
      const at = (isPuertoRico(lon, lat) ? pr : main)([lon, lat])
      if (!at || Number.isNaN(at[0]) || Number.isNaN(at[1])) return null
      return [at[0], at[1]]
    },
    boundsFor(feature) {
      const b = geoPath(forFeature(feature)).bounds(feature as never)
      if (!Number.isFinite(b[0][0]) || !Number.isFinite(b[1][0])) return null
      return b
    },
  }
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | {
      kind: 'ready'
      mode: ResultMapMode
      geometry: ResultGeometry | null
      centroids: Map<string, ZctaPoint>
      centroidList: ZctaPoint[]
      basemap: Basemap | null
    }

export function ResultMap({
  answer,
  onSelect,
}: {
  answer: ComposedAnswer
  /** Optional: a parent that can compare a place (the AnswerCard seam passes none today). */
  onSelect?: (zcta: string) => void
}) {
  const headingId = useId()
  const metricId = useId()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [started, setStarted] = useState(false)
  const [needsButton, setNeedsButton] = useState(false)
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' })
  const [metric, setMetric] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const ordered = useMemo(() => orderedResultPlaces(answer), [answer])
  const shown = useMemo(() => ordered.slice(0, RESULT_MAP_PLACE_CAP), [ordered])
  const driving = useMemo(() => drivingMetricKey(answer), [answer])
  const metricKeys = useMemo(
    () => eligibleMetricKeys(shown, driving),
    [shown, driving],
  )
  const activeMetric = metric && metricKeys.includes(metric) ? metric : (driving ?? metricKeys[0] ?? null)

  // The place-set this load belongs to. A new answer aborts the old
  // load (spec 4.6.3), so a slow fetch can never paint the previous
  // question's neighborhoods under a new card.
  const placeSetKey = useMemo(
    () =>
      shown
        .map((p) => (p.memberZctas ? `${p.zcta}:${[...p.memberZctas].sort().join('.')}` : p.zcta))
        .sort()
        .join(','),
    [shown],
  )

  useEffect(() => {
    if (started) return
    const wrap = wrapRef.current
    if (!wrap) return
    if (typeof IntersectionObserver === 'undefined') {
      setNeedsButton(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true)
          observer.disconnect()
        }
      },
      { rootMargin: '240px' },
    )
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [started])

  useEffect(() => {
    if (!started) return
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    setActiveKey(null)
    ;(async () => {
      // Centroids first (same-origin, cached by the browser): they
      // decide the national span check and supply every dot. A failure
      // here is not fatal for a choropleth — the answer-only mode
      // stands and missing places simply get no dot.
      let centroidList: ZctaPoint[] = []
      let basemap: Basemap | null = null
      try {
        const assets = await loadMapAssets(controller.signal)
        centroidList = assets.centroids
        basemap = assets.basemap
      } catch {
        centroidList = []
      }
      if (controller.signal.aborted) return
      const centroids = new Map(centroidList.map((c) => [c.zcta, c]))
      const mode = resultMapMode(answer, centroids)
      if (mode === 'national') {
        if (centroidList.length === 0) {
          setLoad({ kind: 'failed' })
          return
        }
        setLoad({ kind: 'ready', mode, geometry: null, centroids, centroidList, basemap })
        return
      }
      try {
        let geometry: ResultGeometry
        if (mode === 'county') {
          // County mode loads the aggregates' member geometry for the
          // merged outlines AND, for a mixed answer, the plain places'
          // own geometry — the pre-P2e load fetched members only, so
          // a plain place beside an aggregate (C6's Hilo) had no
          // polygon to draw and silently vanished from the map. A
          // plain place that is itself a member of an aggregate is
          // already in hand from the outline load and is not refetched;
          // only uncovered plain ZCTAs cost a second, scoped-style load.
          const memberZctas = shown.flatMap((p) => p.memberZctas ?? [])
          const plainZctas = shown.filter((p) => !p.memberZctas).map((p) => p.zcta)
          geometry =
            memberZctas.length > 0
              ? await loadCountyOutlineGeometry(memberZctas, { signal: controller.signal })
              : await loadResultGeometry(plainZctas, { signal: controller.signal })
          if (controller.signal.aborted) return
          const uncovered = plainZctas.filter((z) => !geometry.features.has(z))
          if (memberZctas.length > 0 && uncovered.length > 0) {
            const plain = await loadResultGeometry(uncovered, { signal: controller.signal })
            if (controller.signal.aborted) return
            const features = new Map(geometry.features)
            for (const [zcta, feature] of plain.features) features.set(zcta, feature)
            geometry = {
              features,
              missing: [...geometry.missing, ...plain.missing],
              simplified: geometry.simplified || plain.simplified,
              bytes: geometry.bytes + plain.bytes,
            }
          }
        } else {
          geometry = await loadResultGeometry(
            shown.map((p) => p.zcta),
            { signal: controller.signal },
          )
        }
        if (controller.signal.aborted) return
        if (geometry.features.size === 0) {
          setLoad({ kind: 'failed' })
          return
        }
        setLoad({ kind: 'ready', mode, geometry, centroids, centroidList, basemap })
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoad({ kind: 'failed' })
      }
    })()
    return () => controller.abort()
    // The metric is deliberately NOT a dependency: switching it
    // re-colors from figures already in hand and must never refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, placeSetKey])

  const legend = useMemo(
    () => (activeMetric ? legendModel(shown, activeMetric) : null),
    [shown, activeMetric],
  )
  const mapPlaces = useMemo(
    () => (activeMetric ? resultMapPlaces(shown, activeMetric) : []),
    [shown, activeMetric],
  )
  const values = useMemo(
    () => mapPlaces.map((p) => p.figure?.value).filter((v): v is number => typeof v === 'number'),
    [mapPlaces],
  )
  const min = values.length > 0 ? Math.min(...values) : 0
  const max = values.length > 0 ? Math.max(...values) : 0

  const fit = useMemo(() => {
    if (load.kind !== 'ready' || !load.geometry) return null
    return scopedFit([...load.geometry.features.values()])
  }, [load])

  const nationalView = useMemo(() => {
    if (load.kind !== 'ready' || load.mode !== 'national' || load.centroidList.length === 0) return null
    const base = fitBase(load.centroidList)
    const projected = projectAll(base, load.centroidList)
    const indexByZcta = new Map(load.centroidList.map((c, i) => [c.zcta, i]))
    const main = geoAlbersUsa()
    main.scale(base.k)
    main.translate([base.tx, base.ty])
    const pr = geoConicEqualArea().parallels([18, 18])
    pr.scale(base.prK)
    pr.translate([base.prTx, base.prTy])
    const outlineDs: string[] = []
    for (const feature of load.basemap?.features ?? []) {
      const d = geoPath(feature.properties?.STUSAB === 'PR' ? pr : main)(feature as never) as unknown as
        | string
        | null
      if (d) outlineDs.push(d)
    }
    return { projected, indexByZcta, outlineDs }
  }, [load])

  if (answer.status !== 'verified' || answer.places.length === 0 || !activeMetric || !legend) return null

  if (load.kind === 'failed') {
    return (
      <p role="note" className="mt-3 text-xs text-slate-500">
        {FAILURE_LINE}
      </p>
    )
  }

  const activePlace = mapPlaces.find((p) => p.key === activeKey) ?? null
  const activeAnswerPlace = activePlace ? shown.find((p) => p.zcta === activePlace.key) ?? null : null

  const missingKeys =
    load.kind === 'ready' && load.geometry
      ? shown.filter((p) => {
          // Aggregates have no single boundary to miss (their outline
          // is merged from members); a plain place — in choropleth
          // mode, or beside an aggregate in a mixed county answer —
          // with no returned boundary gets the dot + disclosure.
          if (p.memberZctas) return false
          return !load.geometry!.features.has(p.zcta)
        })
      : []
  // The status line's count: the number of elements the map actually
  // renders, computed from the same geometry the renderer consults —
  // an aggregate renders when at least one member polygon is in hand,
  // a plain place renders as a polygon or, failing that, a centroid
  // dot. Counting `shown` instead is what let the C6 status line
  // claim 2 places over a 1-element map. National mode draws from the
  // centroid cloud, not this geometry, so its count stays `shown`.
  const renderedCount =
    load.kind === 'ready' && load.geometry && load.mode !== 'national'
      ? shown.filter((p) => {
          if (p.memberZctas) return p.memberZctas.some((z) => load.geometry!.features.has(z))
          return load.geometry!.features.has(p.zcta) || load.centroids.has(p.zcta)
        }).length
      : shown.length
  const dotLine =
    missingKeys.length > 0
      ? `${missingKeys.length} ${missingKeys.length === 1 ? 'place is' : 'places are'} shown as dots \u2014 the Census Bureau publishes no area boundary for them. Their figures are in the answer above.`
      : null
  const coverageLine = screeningCoverageLine(answer, shown.length)
  const overflow = overflowPlaceNames(answer)

  const onSvgKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const nodes = svgRef.current?.querySelectorAll<SVGElement>('[data-result-place]')
    if (!nodes || nodes.length === 0) return
    const list = [...nodes]
    const at = list.findIndex((n) => n.dataset.resultPlace === activeKey)
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    const next = list[(at + step + list.length) % list.length]
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }

  const placePanel = activePlace && activeAnswerPlace ? (
    <div
      className="mt-2 max-w-xs rounded-md border border-slate-300 bg-white p-2 text-xs shadow-sm"
      data-testid="result-map-place-panel"
    >
      <p className="font-semibold text-slate-900">
        {activePlace.name}{' '}
        <span className="font-normal tabular-nums text-slate-500">
          {activePlace.isCounty
            ? `${activePlace.memberZctas.length} ZIP areas`
            : activePlace.zcta}
        </span>
      </p>
      <dl className="mt-1 space-y-0.5">
        {activeAnswerPlace.figures.map((figure) => (
          <div key={figure.key} className="flex gap-2">
            <dt className="text-slate-500">{metricLabel(figure.key)}</dt>
            <dd className="font-medium tabular-nums text-slate-900">
              {formatAnswerFigure(figure)}
              {figure.marginOfError !== undefined && (
                <span className="ml-1 font-normal text-slate-500">
                  ±{formatMetricNumber(Math.round(figure.marginOfError), 'number', { sweepPrecision: true })}
                  {figure.marginApproximate ? ' approx.' : ''}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {onSelect && !activePlace.isCounty && (
        <p className="mt-1 text-slate-600">Press Enter to compare this place.</p>
      )}
    </div>
  ) : null

  /**
   * One plain place's element: its polygon, a centroid dot for a
   * micro-ZCTA, or a centroid dot when the Census Bureau publishes no
   * boundary — always colored by the place's own figure. Shared by
   * the choropleth renderer and the county renderer, where a mixed
   * answer's plain places get exactly the scoped treatment.
   */
  const renderPlaceElement = (place: ResultMapPlace) => {
    if (load.kind !== 'ready' || !load.geometry || !fit) return null
    const feature = load.geometry!.features.get(place.zcta)
    if (!feature) {
      const centroid = load.centroids.get(place.zcta)
      const at = centroid ? fit.project(centroid.lon, centroid.lat) : null
      if (!at) return null
      return (
        <circle
          key={place.key}
          cx={at[0]}
          cy={at[1]}
          r={7}
          fill={place.figure ? colorForValue(place.figure.value, min, max) : NO_DATA_COLOR}
          stroke="#ffffff"
          strokeWidth={1.5}
        />
      )
    }
    const bounds = fit.boundsFor(feature)
    const boundsArea = bounds ? (bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]) : 0
    if (boundsArea < MICRO_BOUNDS_AREA) {
      // Building-scale ZCTA: sub-pixel as a polygon at metro zoom
      // in every probe variant, so it gets the centroid-dot
      // treatment (spec 4.6) in the place's own color.
      const [lon, lat] = geoCentroid(feature as never)
      const at = fit.project(lon, lat)
      if (!at) return null
      return (
        <circle
          key={place.key}
          cx={at[0]}
          cy={at[1]}
          r={7}
          fill={place.figure ? colorForValue(place.figure.value, min, max) : NO_DATA_COLOR}
          stroke="#ffffff"
          strokeWidth={1.5}
          tabIndex={0}
          data-result-place={place.key}
          aria-label={`${place.name}, ${place.zcta}: ${place.formatted ?? 'no figure for this measure'}`}
          onMouseEnter={() => setActiveKey(place.key)}
          onFocus={() => setActiveKey(place.key)}
          onClick={() => onSelect?.(place.zcta)}
        />
      )
    }
    const d = fit.pathFor(feature)
    if (!d) return null
    const isActive = activeKey === place.key
    return (
      <path
        key={place.key}
        d={d}
        fill={place.figure ? colorForValue(place.figure.value, min, max) : NO_DATA_COLOR}
        stroke={isActive ? '#0f172a' : '#ffffff'}
        strokeWidth={isActive ? 3 : 1}
        tabIndex={0}
        data-result-place={place.key}
        aria-label={`${place.name}, ${place.zcta}: ${place.formatted ?? 'no figure for this measure'}`}
        className="cursor-pointer focus:outline-none"
        onMouseEnter={() => setActiveKey(place.key)}
        onFocus={() => setActiveKey(place.key)}
        onClick={() => onSelect?.(place.zcta)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect?.(place.zcta)
        }}
      />
    )
  }

  const renderChoropleth = () => {
    if (load.kind !== 'ready' || !load.geometry || !fit) return null
    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
        className="block w-full"
        role="group"
        aria-label="Map of the places in this answer"
        onKeyDown={onSvgKeyDown}
      >
        {mapPlaces.map((place) => (place.isCounty ? null : renderPlaceElement(place)))}
      </svg>
    )
  }

  const renderCounty = () => {
    if (load.kind !== 'ready' || !load.geometry || !fit) return null
    const aggregates = mapPlaces.filter((p) => p.isCounty)
    const plains = mapPlaces.filter((p) => !p.isCounty)
    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
        className="block w-full"
        role="group"
        aria-label={
          plains.length > 0
            ? 'Map of the counties and places in this answer'
            : 'Map of the counties in this answer'
        }
        onKeyDown={onSvgKeyDown}
      >
        {aggregates.map((place) => {
          // ONE path per county: every member's subpaths combined
          // into a single element with a single fill — the county's
          // figure. No member ZCTA is ever an element of its own.
          const d = place.memberZctas
            .map((z) => {
              const feature = load.geometry!.features.get(z)
              return feature ? fit.pathFor(feature) : null
            })
            .filter((x): x is string => x !== null)
            .join(' ')
          if (!d) return null
          const isActive = activeKey === place.key
          return (
            <path
              key={place.key}
              d={d}
              fill={place.figure ? colorForValue(place.figure.value, min, max) : NO_DATA_COLOR}
              stroke={isActive ? '#0f172a' : '#ffffff'}
              strokeWidth={isActive ? 3 : 1}
              tabIndex={0}
              data-result-place={place.key}
              aria-label={`${place.name}: ${place.formatted ?? 'no figure for this measure'}`}
              className="cursor-pointer focus:outline-none"
              onMouseEnter={() => setActiveKey(place.key)}
              onFocus={() => setActiveKey(place.key)}
            />
          )
        })}
        {/* Mixed answers only: the plain places draw AFTER (on top
            of) the aggregate outlines, each as its own element with
            its own figure — a plain place that is also an aggregate
            member is still a card place in its own right (C6: Hilo
            beside the Hawaii state average). Pure-county answers have
            no plain places, so this maps over nothing. */}
        {plains.map((place) => renderPlaceElement(place))}
      </svg>
    )
  }

  const renderNational = () => {
    if (load.kind !== 'ready' || !nationalView) return null
    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
        className="block w-full"
        role="group"
        aria-label="Map of the places in this answer across the country"
        onKeyDown={onSvgKeyDown}
      >
        {nationalView.outlineDs.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#cbd5e1" strokeWidth={1} />
        ))}
        {mapPlaces.map((place) => {
          const idx = nationalView.indexByZcta.get(place.zcta)
          if (idx === undefined || !nationalView.projected.ok[idx]) return null
          const cx = nationalView.projected.xs[idx]!
          const cy = nationalView.projected.ys[idx]!
          const isActive = activeKey === place.key
          return (
            <circle
              key={place.key}
              cx={cx}
              cy={cy}
              r={place.figure ? nationalCircleRadius(place.figure.value, min, max) : 5}
              fill={place.figure ? colorForValue(place.figure.value, min, max) : NO_DATA_COLOR}
              fillOpacity={0.85}
              stroke={isActive ? '#0f172a' : '#ffffff'}
              strokeWidth={isActive ? 3 : 1.5}
              tabIndex={0}
              data-result-place={place.key}
              aria-label={`${place.name}, ${place.zcta}: ${place.formatted ?? 'no figure for this measure'}`}
              className="cursor-pointer focus:outline-none"
              onMouseEnter={() => setActiveKey(place.key)}
              onFocus={() => setActiveKey(place.key)}
              onClick={() => onSelect?.(place.zcta)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect?.(place.zcta)
              }}
            />
          )
        })}
      </svg>
    )
  }

  return (
    <div ref={wrapRef} className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center gap-1.5">
        <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Map
        </h3>
        <HelpTip label="About this map">
          The places in the answer above, drawn as their ZIP areas and colored by the figure chosen
          below. Darker means a higher figure. Every figure is also in the answer above.
        </HelpTip>
      </div>

      {!started && needsButton && (
        <button
          type="button"
          onClick={() => setStarted(true)}
          className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          Show the map for this answer
        </button>
      )}
      {!started && !needsButton && (
        <p className="mt-2 text-sm text-slate-500">The map loads when it comes into view.</p>
      )}
      {started && load.kind === 'loading' && (
        <p className="mt-2 text-sm text-slate-500">Loading the map for this answer...</p>
      )}

      {load.kind === 'ready' && (
        <>
          {load.mode === 'national' && (
            <p className="mt-2 text-sm text-slate-600">
              Places in this answer, across the country. Open the Map tab for the full country view.
            </p>
          )}
          <div className="mt-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor={metricId} className="text-sm font-semibold text-slate-900">
                What the colour shows
              </label>
              <HelpTip label="About this figure">
                <p>
                  One scale for every figure: darker = higher.{' '}
                  {METRIC_DEFS_BY_KEY.get(activeMetric)?.note ?? ''}
                </p>
              </HelpTip>
            </div>
            <select
              id={metricId}
              value={activeMetric}
              onChange={(event) => setMetric(event.target.value)}
              className="mt-1 block w-full max-w-xs rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              {metricKeys.map((key) => (
                <option key={key} value={key}>
                  {metricLabel(key)}
                </option>
              ))}
            </select>
          </div>

          <div className="relative mt-3 overflow-hidden rounded-lg border border-slate-200">
            {load.mode === 'choropleth' && renderChoropleth()}
            {load.mode === 'county' && renderCounty()}
            {load.mode === 'national' && renderNational()}
          </div>

          {placePanel}

          <div className="mt-2 text-sm">
            <p className="font-semibold text-slate-900">Legend — {legend.metricLabel}</p>
            {legend.single ? (
              <p className="mt-1 text-[0.8125rem] text-slate-700">{legend.singleText}</p>
            ) : (
              <>
                <div
                  aria-hidden="true"
                  className="mt-2 h-3 w-full rounded-sm"
                  style={{ background: legendGradientCss() }}
                />
                <div className="mt-1 flex justify-between gap-4 text-[0.8125rem] text-slate-700">
                  <span>{legend.lowest?.text}</span>
                  <span className="text-right">{legend.highest?.text}</span>
                </div>
              </>
            )}
            <p className="mt-1 text-[0.8125rem] leading-snug text-slate-600">
              Darker means a higher figure. Every figure is also in the answer above.
            </p>
          </div>

          {coverageLine && (
            <p role="note" className="mt-2 text-xs text-slate-500">
              {coverageLine}
            </p>
          )}
          {overflow.length > 0 && (
            <p role="note" className="mt-1 text-xs text-slate-500">
              Also in this answer: {overflow.join(', ')} — shown in the screening table below.
            </p>
          )}
          {dotLine && (
            <p role="note" className="mt-1 text-xs text-slate-500">
              {dotLine}
            </p>
          )}
          {load.mode === 'county' && answer.countyMethod && (
            <p role="note" className="mt-1 text-xs text-slate-500">
              {answer.countyMethod} Each county is drawn as one area formed from its ZIP areas; the
              figure is the county&rsquo;s, not any single ZIP area&rsquo;s.
            </p>
          )}
          {(answer.geographyLevel === 'place' || answer.geographyLevel === 'state') && load.mode === 'choropleth' && (
            <p role="note" className="mt-1 text-xs text-slate-500">
              Each shape is the ZIP area for the place — it is not the place&rsquo;s legal boundary.
            </p>
          )}
          <p className="mt-1 text-xs leading-snug text-slate-500">
            {HONESTY_LINE}
            {load.geometry?.simplified ? ' Boundaries simplified for display.' : ''}
          </p>

          <p className="sr-only" role="status" aria-live="polite">
            {activePlace
              ? `${activePlace.name}, ${activePlace.isCounty ? 'county' : activePlace.zcta}: ${activePlace.formatted ?? 'no figure for this measure'}.`
              : `The map shows ${renderedCount} places from this answer, colored by ${legend.metricLabel}. Every figure is also in the answer above.`}
          </p>

          <div className="mt-4">
            <FairHousingNotice />
          </div>
        </>
      )}
    </div>
  )
}
