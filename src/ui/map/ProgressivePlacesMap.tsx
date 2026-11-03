import { useEffect, useMemo, useState } from 'react'
import { geoCentroid, geoMercator } from 'd3-geo'
import type { AnswerSource } from '../../core/ai/answer'
import type { ZctaPoint } from '../../core/map/centroids'
import { loadMapAssets } from '../../core/map/projection'
import {
  loadResultGeometry,
  type ResultGeometry,
} from '../../core/map/result-geometry'
import { NO_DATA_COLOR } from '../../core/map/scale'
import {
  aggregateVerdictClass,
  verdictClassLabel,
  type BreadthLabels,
  type BreadthPlace,
  type BreadthStanding,
  type InterimPlace,
  type InterimVerdictClass,
} from '../../core/ai/run-progress'
import { scopedFit } from './ResultMap'

/**
 * The progressive map (Lane A7, owner directive 2026-11-03 02:49
 * HST): while a geographic researched run is in flight, the places
 * named so far render here, colored by their interim standing —
 * the aggregate of the per-criterion verdicts the completed passes
 * support (run-progress.ts derives them through compose's own
 * attribution, so an interim standing is the terminal evidence's
 * judgment arriving early, never a second scoring).
 *
 * Discipline, from the design record:
 * - Mid-run surface only. It mounts under the staged status while
 *   the stage is active and unmounts at the terminal, where the
 *   answer card (and A6's terminal-map decision for it) takes
 *   over. Geometry is fetched through the shipped
 *   loadResultGeometry path, whose cache the terminal map reuses —
 *   nothing here is fetched twice.
 * - Categorical colors, not the choropleth ramp: a verdict class
 *   is not a figure, and a ramp would read as data. 'awaiting'
 *   takes the map's no-data neutral.
 * - The place list in words is always rendered — it is the text
 *   alternative, and it is what remains when geometry fails: one
 *   quiet line, never an empty frame (the terminal map's §4.6
 *   discipline, applied mid-run).
 * - Partial state is labeled partial in words: the heading and
 *   subline say the standings are so-far standings from the checks
 *   completed, and the legend's class labels carry "so far".
 * - Not interactive: no focus targets, no selection — a progress
 *   surface the reader watches, and mid-run focus churn would be
 *   its own defect. The terminal map owns interaction.
 */

const INTERNAL_W = 960
const INTERNAL_H = 500
/** Projected area (internal px^2) below which a polygon is a dot — ResultMap's rule. */
const MICRO_BOUNDS_AREA = 25

const CLASS_COLORS: Record<InterimVerdictClass, string> = {
  meets: '#188038',
  'does-not-meet': '#b3261e',
  mixed: '#e37400',
  awaiting: NO_DATA_COLOR,
}

const GEOMETRY_FAILURE_LINE = 'The map for this run could not be loaded.'

const HONESTY_LINE =
  'Boundaries: U.S. Census Bureau ZIP Code Tabulation Areas (TIGERweb). ' +
  'Standings are interim \u2014 they reflect only the checks completed so far.'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; geometry: ResultGeometry; centroids: Map<string, ZctaPoint> }
  | { kind: 'failed' }

/**
 * The one progressive map surface, in its two modes. Without
 * breadth data it is the A7 interim panel above (InterimPlacesMap).
 * With breadth data it is the breadth surface (BreadthPlacesMap):
 * the same component the run fills mid-flight and the terminal
 * card mounts — one surface, extended, never a parallel one.
 */
export function ProgressivePlacesMap({
  places,
  breadth,
}: {
  places: readonly InterimPlace[]
  breadth?: BreadthMapData
}) {
  if (breadth) return <BreadthPlacesMap data={breadth} />
  return <InterimPlacesMap places={places} />
}

function InterimPlacesMap({ places }: { places: readonly InterimPlace[] }) {
  const zctaKey = useMemo(
    () => [...new Set(places.map((p) => p.zcta))].sort().join(','),
    [places],
  )
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    const zctas = zctaKey === '' ? [] : zctaKey.split(',')
    if (zctas.length === 0) return
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    ;(async () => {
      // Centroids supply the dots for places with no published
      // boundary; a failure there is not fatal (ResultMap's rule).
      let centroids = new Map<string, ZctaPoint>()
      try {
        const assets = await loadMapAssets(controller.signal)
        centroids = new Map(assets.centroids.map((c) => [c.zcta, c]))
      } catch {
        centroids = new Map()
      }
      if (controller.signal.aborted) return
      try {
        const geometry = await loadResultGeometry(zctas, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (geometry.features.size === 0) {
          setLoad({ kind: 'failed' })
          return
        }
        setLoad({ kind: 'ready', geometry, centroids })
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoad({ kind: 'failed' })
      }
    })()
    return () => controller.abort()
  }, [zctaKey])

  const fit = useMemo(() => {
    if (load.kind !== 'ready') return null
    return scopedFit([...load.geometry.features.values()])
  }, [load])

  const classesPresent = useMemo(() => {
    const seen: InterimVerdictClass[] = []
    for (const place of places) {
      const cls = aggregateVerdictClass(place)
      if (!seen.includes(cls)) seen.push(cls)
    }
    return seen
  }, [places])

  const renderPlace = (place: InterimPlace) => {
    if (load.kind !== 'ready' || !fit) return null
    const color = CLASS_COLORS[aggregateVerdictClass(place)]
    const feature = load.geometry.features.get(place.zcta)
    if (!feature) {
      const centroid = load.centroids.get(place.zcta)
      const at = centroid ? fit.project(centroid.lon, centroid.lat) : null
      if (!at) return null
      return (
        <circle
          key={place.zcta}
          cx={at[0]}
          cy={at[1]}
          r={7}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.5}
          aria-label={`${place.name}, ${place.zcta}: ${verdictClassLabel(aggregateVerdictClass(place))}`}
        />
      )
    }
    const bounds = fit.boundsFor(feature)
    const boundsArea = bounds ? (bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]) : 0
    if (boundsArea < MICRO_BOUNDS_AREA) {
      const [lon, lat] = geoCentroid(feature as never)
      const at = fit.project(lon, lat)
      if (!at) return null
      return (
        <circle
          key={place.zcta}
          cx={at[0]}
          cy={at[1]}
          r={7}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.5}
          aria-label={`${place.name}, ${place.zcta}: ${verdictClassLabel(aggregateVerdictClass(place))}`}
        />
      )
    }
    const d = fit.pathFor(feature)
    if (!d) return null
    return (
      <path
        key={place.zcta}
        d={d}
        fill={color}
        stroke="#ffffff"
        strokeWidth={1}
        aria-label={`${place.name}, ${place.zcta}: ${verdictClassLabel(aggregateVerdictClass(place))}`}
      />
    )
  }

  return (
    <div className="mt-3" data-testid="progressive-places-map">
      <p className="text-base font-semibold text-slate-900">Research in progress — places so far</p>
      <p className="mt-1 text-sm text-slate-600">
        Standings so far, from the checks completed. The answer replaces this panel when the run
        finishes.
      </p>
      {load.kind === 'failed' ? (
        <p role="note" className="mt-2 text-sm text-slate-500">
          {GEOMETRY_FAILURE_LINE}
        </p>
      ) : load.kind === 'loading' ? (
        <p className="mt-2 text-sm text-slate-500">Loading the map…</p>
      ) : (
        <div className="relative mt-3 overflow-hidden rounded-lg border border-slate-200">
          <svg
            viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
            className="block w-full"
            role="group"
            aria-label="Map of the places named so far in this run, colored by their interim standing"
          >
            {places.map((place) => renderPlace(place))}
          </svg>
        </div>
      )}
      <div className="mt-2 text-sm">
        <p className="font-semibold text-slate-900">What the colour shows</p>
        <ul className="mt-1 space-y-0.5">
          {classesPresent.map((cls) => (
            <li key={cls} className="flex items-center gap-2 text-slate-700">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm border border-slate-300"
                style={{ background: CLASS_COLORS[cls] }}
              />
              {verdictClassLabel(cls)}
            </li>
          ))}
        </ul>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-slate-700" data-testid="progressive-place-list">
        {places.map((place) => (
          <li key={place.zcta}>
            {place.name} — {verdictClassLabel(aggregateVerdictClass(place))}
          </li>
        ))}
      </ul>
      {load.kind === 'ready' && (
        <p className="mt-1 text-sm leading-snug text-slate-500">
          {HONESTY_LINE}
          {load.geometry.simplified ? ' Boundaries simplified for display.' : ''}
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The breadth surface (owner directive 2026-11-03 12:44 HST)          */
/* ------------------------------------------------------------------ */

/** What the breadth surface renders, interim or terminal. */
export interface BreadthMapData {
  /** The full display set with per-place standings. */
  places: readonly BreadthPlace[]
  labels: BreadthLabels
  /** The criterion the standings characterize ('Political leaning'). */
  criterionLabel: string
  /** The bound geography's plain name ('Texas'). */
  geographyLabel: string
  assessedCount: number
  displayTotal: number
  /** Terminal mode: marks are buttons opening the place's detail. */
  terminal?: boolean
  /** The answer's sources, for the detail panel's citations (terminal). */
  sources?: readonly AnswerSource[]
}

/**
 * Standing colors: categorical, never a ramp — a standing is a
 * class, not a figure. Positive takes the product accent; negative
 * an orange and mixed a purple (no red/green pairing, so the two
 * poles stay distinguishable under the common color-vision
 * deficiencies); unassessed is a pale pending fill with a gray
 * outline, visibly NOT a verdict. Color is never the only channel:
 * the legend names every class in plain words, the list below the
 * map states every assessed place's standing in text, and the
 * terminal click detail repeats it beside the claims.
 */
const BREADTH_COLORS: Record<BreadthStanding, string> = {
  positive: '#1a73e8',
  negative: '#e8710a',
  mixed: '#9334e6',
  unassessed: '#eef1f4',
}
const BREADTH_UNASSESSED_STROKE = '#bdc1c6'
const BREADTH_CLASS_ORDER: readonly BreadthStanding[] = [
  'positive',
  'mixed',
  'negative',
  'unassessed',
]
/** The assessed list's text-alternative cap: the map carries the rest. */
const BREADTH_LIST_LIMIT = 50

/**
 * Longitudes east of the antimeridian (the Aleutian tail) wrap to
 * the negative range so a state fit reads continuously.
 */
function normalizeLon(lon: number): number {
  return lon > 0 ? lon - 360 : lon
}

type BreadthLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; centroids: Map<string, ZctaPoint> }
  | { kind: 'failed' }

/**
 * The breadth map: the bound geography's whole display set as
 * points at their ZIP areas' centre points — the displayable form
 * at state scale (a boundary choropleth of 1,282 areas is neither
 * legible nor this answer's content; K2's keyless geometry cap is
 * a boundary budget, and this surface needs no boundaries at all:
 * the centroid asset is baked and already loaded by every sibling
 * map). Mid-run it fills as batches land — a place transitions
 * from the pending style to its standing color as its verdict
 * arrives, the only animation on the surface, and a state change,
 * not decoration. At the terminal every mark is a button: its
 * detail panel shows the standing and the sourced claims behind
 * it, with their citations. A place with no published centre
 * point is counted in the disclosure line, never dropped silently.
 */
function BreadthPlacesMap({ data }: { data: BreadthMapData }) {
  const [load, setLoad] = useState<BreadthLoadState>({ kind: 'loading' })
  const [selectedZcta, setSelectedZcta] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const assets = await loadMapAssets(controller.signal)
        if (controller.signal.aborted) return
        setLoad({
          kind: 'ready',
          centroids: new Map(assets.centroids.map((c) => [c.zcta, c])),
        })
      } catch {
        if (controller.signal.aborted) return
        setLoad({ kind: 'failed' })
      }
    })()
    return () => controller.abort()
  }, [])

  const marked = useMemo(() => {
    if (load.kind !== 'ready') return []
    return data.places
      .map((place) => ({ place, point: load.centroids.get(place.zcta) }))
      .filter((m): m is { place: BreadthPlace; point: ZctaPoint } => m.point !== undefined)
  }, [load, data.places])
  const unmarkedCount = data.places.length - marked.length

  const fit = useMemo(() => {
    if (marked.length === 0) return null
    const coords = marked.map(
      (m) => [normalizeLon(m.point.lon), m.point.lat] as [number, number],
    )
    const lons = coords.map((c) => c[0])
    const center = (Math.min(...lons) + Math.max(...lons)) / 2
    const projection = geoMercator().rotate([-center, 0])
    const distinct = new Set(coords.map((c) => c.join(','))).size
    if (distinct <= 1) {
      projection
        .center([coords[0]![0], coords[0]![1]])
        .scale(4000)
        .translate([INTERNAL_W / 2, INTERNAL_H / 2])
    } else {
      projection.fitExtent(
        [
          [28, 28],
          [INTERNAL_W - 28, INTERNAL_H - 28],
        ],
        { type: 'MultiPoint', coordinates: coords } as never,
      )
    }
    return (lon: number, lat: number) => projection([normalizeLon(lon), lat])
  }, [marked])

  const classesPresent = useMemo(() => {
    const seen = new Set(data.places.map((p) => p.standing))
    return BREADTH_CLASS_ORDER.filter((cls) => seen.has(cls))
  }, [data.places])

  const assessed = useMemo(
    () => data.places.filter((p) => p.standing !== 'unassessed'),
    [data.places],
  )
  const unassessedCount = data.places.length - assessed.length
  const selected = data.terminal
    ? (data.places.find((p) => p.zcta === selectedZcta) ?? null)
    : null
  const titleByUrl = useMemo(
    () => new Map((data.sources ?? []).map((s) => [s.url, s.title])),
    [data.sources],
  )

  const standingLabel = (standing: BreadthStanding): string => data.labels[standing]

  const renderPoint = ({ place, point }: { place: BreadthPlace; point: ZctaPoint }) => {
    if (!fit) return null
    const at = fit(point.lon, point.lat)
    if (!at) return null
    const fill = BREADTH_COLORS[place.standing]
    const stroke =
      place.standing === 'unassessed' ? BREADTH_UNASSESSED_STROKE : '#ffffff'
    if (!data.terminal) {
      return (
        <circle
          key={place.zcta}
          cx={at[0]}
          cy={at[1]}
          r={5}
          fill={fill}
          stroke={stroke}
          strokeWidth={1}
          style={{ transition: 'fill 300ms ease' }}
          aria-label={`${place.name}: ${standingLabel(place.standing)}`}
        />
      )
    }
    return (
      <circle
        key={place.zcta}
        cx={at[0]}
        cy={at[1]}
        r={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={1}
        role="button"
        tabIndex={0}
        aria-label={`${place.name}: ${standingLabel(place.standing)}. See the sources behind this standing.`}
        onClick={() => setSelectedZcta(place.zcta)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setSelectedZcta(place.zcta)
          }
        }}
        style={{ transition: 'fill 300ms ease', cursor: 'pointer' }}
      />
    )
  }

  return (
    <div className="mt-3" data-testid="breadth-places-map">
      <p className="text-base font-semibold text-slate-900">
        {data.terminal
          ? `The areas of ${data.geographyLabel} by ${data.criterionLabel.toLowerCase()}`
          : `Research in progress — the areas of ${data.geographyLabel}`}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        {data.terminal
          ? `${data.assessedCount} of ${data.displayTotal} areas assessed. Select an area to see the sources behind its standing.`
          : `Standings by ${data.criterionLabel.toLowerCase()}, from the sources gathered so far. The answer replaces this panel when the run finishes.`}
      </p>
      {load.kind === 'failed' || (load.kind === 'ready' && marked.length === 0) ? (
        <p role="note" className="mt-2 text-sm text-slate-500">
          {GEOMETRY_FAILURE_LINE}
        </p>
      ) : load.kind === 'loading' ? (
        <p className="mt-2 text-sm text-slate-500">Loading the map…</p>
      ) : (
        <div className="relative mt-3 overflow-hidden rounded-lg border border-slate-200">
          <svg
            viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
            className="block w-full"
            role="group"
            aria-label={`Map of the areas of ${data.geographyLabel}, colored by their standing on ${data.criterionLabel.toLowerCase()}`}
          >
            {marked.map((m) => renderPoint(m))}
          </svg>
        </div>
      )}
      <div className="mt-2 text-sm">
        <p className="font-semibold text-slate-900">What the colour shows</p>
        <ul className="mt-1 space-y-0.5">
          {classesPresent.map((cls) => (
            <li key={cls} className="flex items-center gap-2 text-slate-700">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm border border-slate-300"
                style={{ background: BREADTH_COLORS[cls] }}
              />
              {standingLabel(cls)}
            </li>
          ))}
        </ul>
      </div>
      {selected && (
        <div
          className="mt-3 rounded-lg border border-slate-200 p-3"
          data-testid="breadth-place-detail"
        >
          <p className="text-sm font-semibold text-slate-900">
            {selected.name} — {standingLabel(selected.standing)}
          </p>
          {selected.standing === 'unassessed' ? (
            <p className="mt-1 text-sm text-slate-600">
              No cited source characterized this area in this run, so it carries no standing.
            </p>
          ) : (
            <ul className="mt-1 space-y-1.5 text-sm text-slate-700">
              {(selected.claims ?? []).map((claim, i) => (
                <li key={i}>
                  {claim.text}{' '}
                  {claim.sourceUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 underline"
                    >
                      {titleByUrl.get(url) ?? url}
                    </a>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ul className="mt-2 space-y-0.5 text-sm text-slate-700" data-testid="breadth-place-list">
        {assessed.slice(0, BREADTH_LIST_LIMIT).map((place) => (
          <li key={place.zcta}>
            {place.name} — {standingLabel(place.standing)}
          </li>
        ))}
        {assessed.length > BREADTH_LIST_LIMIT && (
          <li>
            {assessed.length - BREADTH_LIST_LIMIT} more assessed areas are marked on the map.
          </li>
        )}
      </ul>
      {unassessedCount > 0 && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {data.terminal
            ? `${unassessedCount} areas were not assessed — no cited source characterized them.`
            : `${unassessedCount} areas not yet assessed.`}
        </p>
      )}
      {load.kind === 'ready' && unmarkedCount > 0 && (
        <p role="note" className="mt-1 text-sm text-slate-500">
          {unmarkedCount} of {data.places.length} areas have no published centre point and are
          not marked.
        </p>
      )}
      {load.kind === 'ready' && (
        <p className="mt-1 text-sm leading-snug text-slate-500">
          Areas are marked at the centre point of their ZIP area (U.S. Census Bureau).
          {data.terminal
            ? ' Standings come only from the cited sources named with each area.'
            : ' Standings are interim — they reflect only the sources gathered so far.'}
        </p>
      )}
    </div>
  )
}
