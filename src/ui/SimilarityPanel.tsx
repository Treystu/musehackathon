/**
 * Find ZIP codes similar to one of yours, using disclosed starting weights that
 * the reader can change.
 *
 * Everything this panel does follows from one position: a similarity result is
 * inherently a ranking, so it exists only when the reader has asked for it, and
 * the tool itself never chooses which matching area to put in front of you.
 *
 * **Off by default.** The flag is a localStorage key beside the Census key, and
 * the panel renders as a closed disclosure until it is turned on. No visitor is
 * ranked at without a request. This is the mitigation that replaced the legal
 * sign-off this project will not obtain — `GOVERNANCE.md` records plainly that no
 * attorney has reviewed the design and that this is a design decision about
 * defaults, not a compliance finding.
 *
 * **The starting values are explicit and adjustable.** Four sliders begin at
 * equal weights and the measured cutoff, are persisted locally, and can be
 * changed by the reader. Outcome-named templates were dropped rather than
 * deferred: a template that names the outcome a reader should want is the
 * highest-steering surface in the whole plan, and with no attorney review there
 * is no basis on which to ship one later either.
 *
 * **Results are alphabetical.** The distance is shown beside each match and the
 * cut-off is a slider, but the order is A-Z by ZIP code, because "closest first"
 * would make this a best-match list, which is the one thing this app does not do.
 *
 * Everything is computed locally from the country-wide screen already in memory,
 * so asking costs no request. That is also why the panel asks for a loaded
 * screen rather than fetching: the plan's original design baked 0.5-1 MB of
 * figures to compare against, five to ten times the whole application, for data
 * the visitor already holds.
 */
import { useMemo, useState } from 'react'

import {
  comparisonDims,
  DEFAULT_CUTOFF,
  DEFAULT_WEIGHTS,
  findSimilar,
  isSimilarityMetric,
  originFigures,
  SIMILARITY_METRICS,
  type SimilarityMetric,
  type Weights,
} from '../core/similarity'
import type { AreaRow } from '../core/plugins/acs'
import type { MuseProvider } from '../core/ai/provider'
import { ExplainAction } from './ai/ExplainAction'
import { figureInputsFromAreaRow } from './ai/figure-input'

const FLAG_KEY = 'civicscope.similarity.v1.enabled'
const WEIGHTS_KEY = 'civicscope.similarity.v1.weights'
const CUTOFF_KEY = 'civicscope.similarity.v1.cutoff'

const LABELS: Record<SimilarityMetric, string> = {
  median_rent_burden_pct: 'Rent burden',
  median_gross_rent: 'Monthly rent',
  median_home_value: 'Home value',
  median_household_income: 'Household income',
}

/** Reads the flag. Tolerates a browser with storage disabled: off, not broken. */
function flagOn(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === 'true'
  } catch {
    return false
  }
}

/** Stored weights are validated against the metric list, so a stale or hand-edited key cannot add a dimension. */
function storedWeights(): Weights {
  try {
    const raw = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? 'null') as Record<string, unknown> | null
    const out: Weights = { ...DEFAULT_WEIGHTS }
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (isSimilarityMetric(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          out[key] = value
        }
      }
    }
    return out
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

function storedCutoff(): number {
  try {
    const raw = Number(localStorage.getItem(CUTOFF_KEY))
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CUTOFF
  } catch {
    return DEFAULT_CUTOFF
  }
}

export function SimilarityPanel({
  sweep,
  selected,
  onAdd,
  explainProvider,
  initialOriginZip = '',
}: {
  /** The loaded country-wide screen; the comparison is local, so this is the whole data source. */
  sweep: readonly AreaRow[]
  /** ZIP codes in the comparison, so their buttons read as done. */
  selected: readonly string[]
  onAdd: (zcta: string) => void
  explainProvider?: MuseProvider
  initialOriginZip?: string
}) {
  // An explicit Ask similarity intent is a request for this ranking, which is the
  // condition the off-by-default rule exists to require. Seeding the panel that
  // way opens it for this visit without flipping the stored default.
  const [enabled, setEnabled] = useState(() => flagOn() || /^\d{5}$/.test(initialOriginZip))
  const [weights, setWeights] = useState<Weights>(() => storedWeights())
  const [cutoff, setCutoff] = useState<number>(() => storedCutoff())
  const [originZip, setOriginZip] = useState(() => /^\d{5}$/.test(initialOriginZip) ? initialOriginZip : '')
  const [open, setOpen] = useState(() => /^\d{5}$/.test(initialOriginZip))
  const [explainZip, setExplainZip] = useState<string | null>(null)

  function persistEnabled(on: boolean) {
    setEnabled(on)
    try {
      localStorage.setItem(FLAG_KEY, on ? 'true' : 'false')
    } catch {
      /* storage disabled: the choice lasts this visit */
    }
  }

  function persistWeights(next: Weights) {
    setWeights(next)
    try {
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(next))
    } catch {
      /* nothing to do; the choice lasts this visit */
    }
  }

  function persistCutoff(next: number) {
    setCutoff(next)
    try {
      localStorage.setItem(CUTOFF_KEY, String(next))
    } catch {
      /* nothing to do; the choice lasts this visit */
    }
  }

  const origin = useMemo(
    () => (originZip && /^\d{5}$/.test(originZip) ? sweep.find((r) => r.zcta === originZip) ?? null : null),
    [originZip, sweep],
  )
  const rowByZip = useMemo(() => new Map(sweep.map((row) => [row.zcta, row] as const)), [sweep])

  const results = useMemo(
    () => (origin ? findSimilar(sweep, origin, weights, cutoff) : []),
    [sweep, origin, weights, cutoff],
  )

  const originFigs = useMemo(() => (origin ? originFigures(origin) : null), [origin])

  /*
   * The dimensions the comparison actually runs on: weighted and carried by the
   * origin. An origin figure that is absent cannot be compared, so candidates
   * are not required to carry it either — but the reader is told the match ran
   * on fewer than four figures, because a two-figure match is a weaker claim
   * than a four-figure one and quietly presenting them as the same would be the
   * exact overclaim this panel exists to avoid.
   */
  const dims = origin ? comparisonDims(origin, weights) : []
  const explainMatch = explainZip ? rowByZip.get(explainZip) ?? null : null
  const showExplanation = Boolean(
    explainProvider && origin && explainMatch && results.some((row) => row.zcta === explainZip),
  )
  const explanationFigures = origin && explainMatch
    ? [
        ...figureInputsFromAreaRow(origin, dims),
        ...figureInputsFromAreaRow(explainMatch, dims),
      ]
    : []

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <summary className="min-h-[44px] cursor-pointer text-sm font-medium text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">
        Find similar ZIP codes {enabled ? '' : '(off by default)'}
      </summary>

      {!enabled ? (
        <div className="mt-2">
          <p className="text-xs text-slate-600">
            This is off because a similarity result is a ranking: it only runs when you ask for it. It starts
            with equal weights and a 0.10 distance cut-off; you can change both. Results are ordered
            alphabetically rather than by closeness, and no protected-class measure can be weighted.
          </p>
          <button
            type="button"
            onClick={() => persistEnabled(true)}
            className="mt-2 min-h-[44px] rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            Turn on similar-ZIP search
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-xs text-slate-600">
            Weighted by the sliders you set, compared against the {sweep.length.toLocaleString('en-US')} areas
            already loaded in this browser. Distance is each figure's share of the country's actual loaded range,
            not a fixed scale. Results are alphabetical — the tool does not pick which match comes first — and an
            area that does not publish all the compared figures is left out rather than scored on a subset.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {SIMILARITY_METRICS.map((metric) => (
              <label key={metric} htmlFor={`weight-${metric}`} className="block text-xs text-slate-700">
                <span className="font-medium">{LABELS[metric]}</span>
                <input
                  id={`weight-${metric}`}
                  type="range"
                  min={0}
                  max={4}
                  step={0.25}
                  value={weights[metric]}
                  onChange={(e) => persistWeights({ ...weights, [metric]: Number(e.target.value) })}
                  className="mt-1 w-full accent-slate-900"
                />
                <span className="text-slate-500">
                  weight {weights[metric] === 0 ? 'off' : `${Math.round((weights[metric] / 4) * 100)}%`}
                </span>
              </label>
            ))}
          </div>

          <label htmlFor="similarity-cutoff" className="mt-3 block text-xs text-slate-700">
            <span className="font-medium">Distance cut-off</span>
            <input
              id="similarity-cutoff"
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={cutoff}
              onChange={(e) => persistCutoff(Number(e.target.value))}
              className="mt-1 w-full accent-slate-900"
            />
            <span className="text-slate-500">
              {cutoff.toFixed(2)} — smaller keeps only the closest matches
            </span>
          </label>

          <label htmlFor="similarity-origin" className="mt-3 block text-sm font-medium text-slate-800">
            Similar to ZIP code
            <input
              id="similarity-origin"
              type="text"
              inputMode="numeric"
              value={originZip}
              onChange={(e) => setOriginZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="78701"
              className="mt-1 w-32 min-h-[44px] rounded-md border border-slate-300 px-2 py-1 font-mono text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            />
          </label>
          <p className="text-xs text-slate-500">Enter a ZIP code that is loaded above.</p>

          {originZip.length === 5 && !origin && (
            <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900" role="alert">
              {originZip} is not in the loaded screen, so there is nothing to compare from.
            </p>
          )}

          {origin && originFigs && (
            <div className="mt-3">
              <p className="text-xs text-slate-600">
                <strong>{origin.zcta}</strong> carries {SIMILARITY_METRICS.filter((m) => originFigs[m] !== null && originFigs[m] !== undefined).length} of the{' '}
                {SIMILARITY_METRICS.length} weighted figures. Comparing on {dims.length === SIMILARITY_METRICS.length ? 'all of them' : `${dims.length} of them`}.{' '}
                {results.length.toLocaleString('en-US')} of {sweep.length.toLocaleString('en-US')} areas are within your cut-off.
              </p>

              {results.length === 0 ? (
                <p className="mt-2 text-sm text-slate-700">
                  Nothing is within {cutoff.toFixed(2)}. Loosen the cut-off or turn a weight down.
                  {dims.length < SIMILARITY_METRICS.length && ' Fewer compared figures also means fewer areas can be scored at all.'}
                </p>
              ) : (
                <ul className="mt-2 max-h-96 overflow-auto">
                  {results.map((r) => {
                    const added = selected.includes(r.zcta)
                    return (
                      <li
                        key={r.zcta}
                        className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 py-2"
                      >
                        <div className="min-w-0">
                          <span className="font-mono text-sm font-medium text-slate-900">{r.zcta}</span>
                          <span className="ml-2 text-xs text-slate-500">distance {r.distance.toFixed(2)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onAdd(r.zcta)}
                          disabled={added}
                          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                        >
                          {added ? 'Added' : 'Compare'}
                        </button>
                        {explainProvider && (
                          <button
                            type="button"
                            onClick={() => setExplainZip(r.zcta)}
                            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                          >
                            Explain {r.zcta}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {showExplanation && explainProvider && (
                <div className="mt-2">
                  <ExplainAction
                    title="this similarity result"
                    figureSetId="similarity"
                    figures={explanationFigures}
                    provider={explainProvider}
                  />
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => persistEnabled(false)}
            className="mt-3 min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            Turn off
          </button>
        </div>
      )}
    </details>
  )
}
