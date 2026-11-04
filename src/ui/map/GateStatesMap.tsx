/**
 * GateStatesMap — the map for one geography-gated answer (drug-law
 * specimen cure, 2026-11-04), mounted under the AnswerCard in place
 * of the result choropleth (which resultMapRelevant suppresses for
 * gate answers: its data — the unbounded screen's cheapest ZIPs —
 * is the wrong geography for this answer class).
 *
 * The frame is the QUALIFYING GEOGRAPHIES: every state the shipped
 * basemap carries, drawn from the same winding-normalized geometry
 * the rest of the map stack uses, with fills taken from the pure
 * model in core/map/gate-map.ts — bound states shaded by their
 * cheapest screened figure on the answer's headline measure (the
 * shipped color ramp), the winning state outlined and labelled,
 * classified-but-unbound states in a pale wash, bound-but-
 * unmeasured states in the no-data tone, all other states in a
 * quiet neutral. Every figure the map emits — legend ends, state
 * titles, the caption — is looked up from the answer's gate record
 * by state code; nothing is computed in this layer.
 *
 * Honesty rules, mirroring ResultMap's: geometry loads lazily when
 * the map approaches the viewport (where IntersectionObserver does
 * not exist the load starts on mount); a load that does not settle
 * within the same 90-second deadline converts to one quiet failure
 * line with no canvas; a basemap that fails leaves the same line —
 * never an empty frame.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { geoCentroid } from 'd3-geo'

import type { ComposedAnswer } from '../../core/ai/answer'
import { gateMapModel } from '../../core/map/gate-map'
import { loadMapAssets, type Basemap } from '../../core/map/projection'
import { scopedFit } from './ResultMap'
import {
  formatAnswerFigure,
  legendGradientCss,
  metricLabel,
} from '../../core/map/result-scale'
import { NO_DATA_COLOR } from '../../core/map/scale'
import { FairHousingNotice } from '../FairHousingNotice'
import { HelpTip } from '../ai/HelpTip'

const FAILURE_LINE =
  'The map for this answer could not be loaded. Every figure is in the answer above and the screening table below.'
const LOAD_TIMEOUT_MS = 90_000
const CLASSIFIED_FILL = '#d7e3f4'
const OUTSIDE_FILL = '#f1f3f5'
const WINNER_STROKE = '#1a73e8'

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; basemap: Basemap }

export function GateStatesMap({ answer }: { answer: ComposedAnswer }) {
  const headingId = useId()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [started, setStarted] = useState(false)
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' })

  // Lazy start, ResultMap's pattern: only fetch when the map
  // approaches the viewport; without IntersectionObserver, start on
  // mount. The observer is a fetch deferral, never a gate.
  useEffect(() => {
    if (started) return
    const el = wrapRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setStarted(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true)
          observer.disconnect()
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [started])

  useEffect(() => {
    if (!started || load.kind !== 'idle') return
    const controller = new AbortController()
    let settled = false
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true
        controller.abort()
        setLoad({ kind: 'failed' })
      }
    }, LOAD_TIMEOUT_MS)
    setLoad({ kind: 'loading' })
    loadMapAssets(controller.signal)
      .then((assets) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (!assets.basemap) {
          setLoad({ kind: 'failed' })
          return
        }
        setLoad({ kind: 'ready', basemap: assets.basemap })
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        setLoad({ kind: 'failed' })
      })
    return () => {
      settled = true
      clearTimeout(deadline)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started])

  const ready = load.kind === 'ready' ? load : null
  const model = useMemo(() => {
    if (!ready) return null
    const basemapStates = ready.basemap.features
      .map((f) => ({
        code: String(f.properties?.STUSAB ?? ''),
        name: String(f.properties?.BASENAME ?? ''),
      }))
      .filter((s) => s.code.length === 2)
    return gateMapModel(answer, basemapStates)
  }, [ready, answer])

  const paths = useMemo(() => {
    if (!ready || !model) return null
    const fit = scopedFit(
      ready.basemap.features.map((f) => ({
        type: 'Feature',
        properties: f.properties ?? {},
        geometry: f.geometry,
      })) as never,
    )
    const byCode = new Map(model.states.map((s) => [s.code, s]))
    return ready.basemap.features.map((feature, i) => {
      const code = String(feature.properties?.STUSAB ?? '')
      const state = byCode.get(code)
      if (!state) return null
      const d = fit.pathFor(feature as never)
      if (!d) return null
      const fill =
        state.stateClass === 'valued'
          ? (state.color as string)
          : state.stateClass === 'unmeasured'
            ? NO_DATA_COLOR
            : state.stateClass === 'classified'
              ? CLASSIFIED_FILL
              : OUTSIDE_FILL
      const centroid = geoCentroid(feature as never)
      const projected = fit.project(centroid[0], centroid[1])
      return { key: `${code}-${i}`, code, state, d, fill, labelAt: projected }
    })
  }, [ready, model])

  const gate = answer.geographyGate
  if (!gate) return null
  const headlineLabel = metricLabel(gate.headlineKey)
  const cheapestText =
    model?.cheapest != null
      ? formatAnswerFigure({ key: gate.headlineKey, value: model.cheapest.value })
      : null

  return (
    <div ref={wrapRef} className="mt-4">
      <div className="flex items-baseline gap-2">
        <h3 id={headingId} className="text-sm font-medium text-slate-700">
          Qualifying states by their cheapest screened {headlineLabel.toLowerCase()}
        </h3>
        <HelpTip label="About this map">
          Each qualifying state is shaded by the cheapest screened place in it on the measure
          the answer ranks by. States the research classified but the screen did not run inside
          are shown in pale blue; a qualifying state with no measured place is shown in the
          no-data tone.
        </HelpTip>
      </div>
      {load.kind === 'failed' && (
        <p role="note" className="mt-2 text-sm text-slate-500">
          {FAILURE_LINE}
        </p>
      )}
      {(load.kind === 'idle' || load.kind === 'loading') && (
        <p role="note" className="mt-2 text-sm text-slate-500">
          Loading the map for this answer...
        </p>
      )}
      {ready && model && paths && (
        <>
          <svg
            viewBox="0 0 960 500"
            role="img"
            aria-labelledby={headingId}
            className="mt-2 w-full"
          >
            {paths.map(
              (p) =>
                p && (
                  <path
                    key={p.key}
                    d={p.d}
                    fill={p.fill}
                    stroke={p.state.isWinner ? WINNER_STROKE : '#ffffff'}
                    strokeWidth={p.state.isWinner ? 2.5 : 0.75}
                  >
                    <title>
                      {p.state.stateClass === 'valued'
                        ? `${p.state.name}: cheapest screened ${p.state.cheapestPlaceName} at ${formatAnswerFigure({ key: gate.headlineKey, value: p.state.value as number })}`
                        : p.state.stateClass === 'unmeasured'
                          ? `${p.state.name}: qualifying, but no screened place carries a ${headlineLabel.toLowerCase()} figure`
                          : p.state.stateClass === 'classified'
                            ? `${p.state.name}: classified by the research; the screen ran inside the winning state alone`
                            : p.state.name}
                    </title>
                  </path>
                ),
            )}
            {paths.map(
              (p) =>
                p &&
                p.state.isWinner &&
                p.labelAt && (
                  <text
                    key={`label-${p.key}`}
                    x={p.labelAt[0]}
                    y={p.labelAt[1]}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="600"
                    fill="#0b3d91"
                  >
                    {p.state.name}
                  </text>
                ),
            )}
          </svg>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>
              {model.min !== null && model.max !== null && model.min !== model.max
                ? `${formatAnswerFigure({ key: gate.headlineKey, value: model.min })}`
                : ''}
            </span>
            <span
              aria-hidden="true"
              className="inline-block h-2 flex-1 rounded"
              style={{ background: legendGradientCss() }}
            />
            <span>
              {model.min !== null && model.max !== null && model.min !== model.max
                ? `${formatAnswerFigure({ key: gate.headlineKey, value: model.max })}`
                : ''}
            </span>
          </div>
          <p role="note" className="mt-2 text-sm text-slate-500">
            {gate.winnerState
              ? `${gate.winnerState.name} is the state the cited research singles out for the question's first criterion; the screen ran inside it alone. `
              : ''}
            {model.cheapest && cheapestText
              ? `The cheapest screened place in the qualifying set is ${model.cheapest.placeName} (${model.cheapest.stateName}) at ${cheapestText}. `
              : ''}
            Boundaries: U.S. Census Bureau state outlines. Figures: American Community Survey
            2023, as screened for the answer above.
          </p>
          <FairHousingNotice />
        </>
      )}
    </div>
  )
}
