import { useEffect, useMemo, useState } from 'react'
import { geoCentroid } from 'd3-geo'
import type { AnswerPlace } from '../../core/ai/answer'
import type { ZctaPoint } from '../../core/map/centroids'
import { loadMapAssets } from '../../core/map/projection'
import {
  loadResultGeometry,
  type ResultGeometry,
} from '../../core/map/result-geometry'
import {
  answerPlaceAnchorId,
} from '../../core/map/result-scale'
import { scopedFit } from './ResultMap'

/**
 * The qualifying-places map (Lane completion K7, owner directive
 * 2026-11-03 02:46 HST): a research-first terminal card's own
 * map. The chart rules suppress the metric choropleth for this
 * class — there is no screened set and no driving metric, so a
 * colored-by-variable map would decorate rather than inform —
 * but the answer's content IS its geography: the set of places
 * the research named and the Census data matched. This map plots
 * exactly those places, each marked at its ZIP area, in a single
 * presence color that encodes nothing but membership (no ramp, no
 * verdict color: the card entries above carry the verdicts and
 * the figures). Every mark is a button: activating it moves the
 * reader to that place's own entry in the card — its figures and
 * its cited sources — which is the details-plus-sources target
 * the directive names.
 *
 * Discipline, shared with the progressive map and the result
 * map: geometry rides the shipped loadResultGeometry path
 * (keyless since K2, so an exhausted Census budget cannot fail
 * this map); a place with no published boundary marks at its
 * centroid; a place with neither is not marked and is counted in
 * the disclosure line below the map; geometry failure renders
 * one quiet line, never an empty frame. The text alternative is
 * the card's own place entries, adjacent in the same section —
 * unlike the mid-run progressive panel, which stands alone, this
 * map never renders apart from the entries it points into.
 */

const INTERNAL_W = 960
const INTERNAL_H = 500
/** Projected area (internal px^2) below which a polygon is a dot — ResultMap's rule. */
const MICRO_BOUNDS_AREA = 25
/** Presence only: one categorical color, deliberately off the verdict palette. */
const PLACE_COLOR = '#2563eb'

const FAILURE_LINE =
  'The map for this answer could not be loaded. Every named place is listed in the answer above.'

const HONESTY_LINE = 'Boundaries: U.S. Census Bureau ZIP Code Tabulation Areas (TIGERweb).'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; geometry: ResultGeometry; centroids: Map<string, ZctaPoint> }
  | { kind: 'failed' }

export function QualifyingPlacesMap({ places }: { places: readonly AnswerPlace[] }) {
  // County aggregates carry a synthetic key, not a ZIP area:
  // they are not points and never enter the map's set.
  const pointable = useMemo(() => places.filter((p) => !p.memberZctas), [places])
  const zctaKey = useMemo(
    () => [...new Set(pointable.map((p) => p.zcta))].sort().join(','),
    [pointable],
  )
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    const zctas = zctaKey === '' ? [] : zctaKey.split(',')
    if (zctas.length === 0) return
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    ;(async () => {
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

  const markedCount = useMemo(() => {
    if (load.kind !== 'ready') return 0
    return pointable.filter(
      (p) => load.geometry.features.has(p.zcta) || load.centroids.has(p.zcta),
    ).length
  }, [load, pointable])

  const activate = (place: AnswerPlace) => {
    const el = document.getElementById(answerPlaceAnchorId(place.zcta))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  }

  const renderPlace = (place: AnswerPlace) => {
    if (load.kind !== 'ready' || !fit) return null
    const shared = {
      fill: PLACE_COLOR,
      stroke: '#ffffff',
      role: 'button' as const,
      tabIndex: 0,
      'aria-label': `See the details and sources for ${place.name} in the answer`,
      onClick: () => activate(place),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate(place)
        }
      },
      style: { cursor: 'pointer' },
    }
    const feature = load.geometry.features.get(place.zcta)
    if (!feature) {
      const centroid = load.centroids.get(place.zcta)
      const at = centroid ? fit.project(centroid.lon, centroid.lat) : null
      if (!at) return null
      return (
        <circle key={place.zcta} cx={at[0]} cy={at[1]} r={8} strokeWidth={1.5} {...shared} />
      )
    }
    const bounds = fit.boundsFor(feature)
    const boundsArea = bounds ? (bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]) : 0
    if (boundsArea < MICRO_BOUNDS_AREA) {
      const [lon, lat] = geoCentroid(feature as never)
      const at = fit.project(lon, lat)
      if (!at) return null
      return (
        <circle key={place.zcta} cx={at[0]} cy={at[1]} r={8} strokeWidth={1.5} {...shared} />
      )
    }
    const d = fit.pathFor(feature)
    if (!d) return null
    return <path key={place.zcta} d={d} strokeWidth={1} {...shared} />
  }

  return (
    <div className="mt-4" data-testid="qualifying-places-map">
      <p className="text-base font-semibold text-slate-900">The places this answer names</p>
      <p className="mt-1 text-sm text-slate-600">
        Each marked ZIP area is a place named in the answer above. Select one to jump to its
        details and sources.
      </p>
      {load.kind === 'failed' ? (
        <p role="note" className="mt-2 text-sm text-slate-500">
          {FAILURE_LINE}
        </p>
      ) : load.kind === 'loading' ? (
        <p className="mt-2 text-sm text-slate-500">Loading the map…</p>
      ) : (
        <>
          <div className="relative mt-3 overflow-hidden rounded-lg border border-slate-200">
            <svg
              viewBox={`0 0 ${INTERNAL_W} ${INTERNAL_H}`}
              className="block w-full"
              role="group"
              aria-label="Map of the places this answer names; each marked place is a button that jumps to its details in the answer"
            >
              {pointable.map((place) => renderPlace(place))}
            </svg>
          </div>
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-700">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm border border-slate-300"
              style={{ background: PLACE_COLOR }}
            />
            A place this answer names
          </p>
          {markedCount < pointable.length && (
            <p role="note" className="mt-1 text-sm text-slate-500">
              {markedCount} of {pointable.length} named places are marked; the rest are named in
              the answer above.
            </p>
          )}
          <p className="mt-1 text-sm leading-snug text-slate-500">
            {HONESTY_LINE}
            {load.geometry.simplified ? ' Boundaries simplified for display.' : ''}
          </p>
        </>
      )}
    </div>
  )
}
