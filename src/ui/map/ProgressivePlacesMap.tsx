import { useEffect, useMemo, useState } from 'react'
import { geoCentroid } from 'd3-geo'
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

export function ProgressivePlacesMap({ places }: { places: readonly InterimPlace[] }) {
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
