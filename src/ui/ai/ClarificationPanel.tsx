import { useState } from 'react'
import {
  canResolveClarification,
  resolveClarification,
} from '../../core/ai/intent-edit'
import { canRun } from '../../core/ai/intent-schema'
import { costDefaultMeasure } from '../../core/ai/national-screen'
import type { ValidatedIntent } from '../../core/ai/provider'
import { measureLabel } from './plain-labels'

/**
 * The domain default measure for a clarified request that names a
 * place but no measure (owner ruling F-C, 2026-11-02). Derived from
 * the shipped default-measure logic — national-screen's
 * costDefaultMeasure answers the canonical measure-less cost
 * question ("cheapest place to live") with median gross rent, the
 * stat band's headline cost figure — rather than restating a second
 * default here, so the panel and the screen rescue can never drift
 * apart. The fallback literal is that same key, for the day the
 * canonical phrase stops matching.
 */
const DOMAIN_DEFAULT_MEASURE =
  costDefaultMeasure('cheapest place to live') ?? 'median_gross_rent'

export interface ClarificationCandidates {
  geographies: string[]
  metricKeys: string[]
}

const ERROR_COPY: Record<string, string> = {
  clarification_required:
    'Choose a place and a measure, or one screen measure for the whole country, before continuing.',
  not_allowlisted: 'That measure is not on the approved list.',
  shape_invalid: 'That choice is not valid.',
}

/** Candidate picker. Nothing executes until the clarification is resolved. */
export function ClarificationPanel({
  intent,
  candidates,
  onResolve,
}: {
  intent: ValidatedIntent
  candidates: ClarificationCandidates
  onResolve: (next: ValidatedIntent) => void
}) {
  const [geographies, setGeographies] = useState<string[]>([])
  const [metricKeys, setMetricKeys] = useState<string[]>([])
  const [error, setError] = useState('')

  const places = candidates.geographies.filter((g) => !intent.geographies.includes(g))
  const metrics = candidates.metricKeys.filter((k) => !intent.metricKeys.includes(k))
  const mergedGeographies = [...intent.geographies, ...geographies]
  const mergedMetricKeys = [...intent.metricKeys, ...metricKeys]
  // One answer: the button enables exactly when the merged picks would run.
  const coreCanResolve = canResolveClarification({
    mode: intent.mode,
    geographies: mergedGeographies,
    metricKeys: mergedMetricKeys,
    filters: intent.filters,
  })
  /**
   * Run-with-default (owner ruling F-C, 2026-11-02): a geography with
   * no measure was the dead click — the button stayed disabled (or,
   * in the owner's live build, clicked to nothing) because the core
   * predicate requires a measure. With a place chosen and no measure
   * anywhere, the domain default measure completes the request and
   * it RUNS; the default is disclosed in the hint line below, never
   * applied silently. canRun is the arbiter, so a mode the default
   * cannot complete (a one-place comparison) stays disabled.
   */
  const runsWithDefault =
    !coreCanResolve &&
    mergedGeographies.length > 0 &&
    mergedMetricKeys.length === 0 &&
    canRun({
      mode: intent.mode,
      geographies: mergedGeographies,
      metricKeys: [DOMAIN_DEFAULT_MEASURE],
      filters: intent.filters,
      clarificationNeeded: false,
    })
  const canResolve = coreCanResolve || runsWithDefault
  // The one-line honest hint for the states that cannot run: what is
  // still missing, in plain words. A disabled button with no hint was
  // half of the F-C defect — the reader could not tell why.
  const incompleteHint = canResolve
    ? runsWithDefault
      ? `No measure chosen, so this runs on ${measureLabel(DOMAIN_DEFAULT_MEASURE).toLowerCase()} — the cost measure this tool uses when none is named.`
      : null
    : mergedGeographies.length === 0 && mergedMetricKeys.length === 0
      ? 'Pick a place and a measure, or a measure on its own to screen the whole country.'
      : intent.mode === 'compare' && mergedGeographies.length < 2
        ? 'Comparing needs two places — pick one more place to run these choices.'
        : 'These choices cannot run yet — a place and a measure that can screen are both needed.'

  function togglePlace(value: string) {
    setGeographies((current) =>
      current.includes(value) ? current.filter((x) => x !== value) : [...current, value],
    )
  }

  function toggleMetric(value: string) {
    setMetricKeys((current) =>
      current.includes(value) ? current.filter((x) => x !== value) : [...current, value],
    )
  }

  // The empty-Places copy is one quiet honest line (2026-11-02): the
  // old text told the reader to "add a place above", pointing at a
  // control this panel does not contain. The panel's own forward
  // paths are the measure picks below and the choices already made,
  // so the empty state names only those.
  function resolve() {
    // Defence in depth for F-C: the button is disabled whenever this
    // cannot run, so a silent no-op is unreachable from the UI; if
    // resolve is ever invoked in that state anyway, it answers with
    // the hint rather than doing nothing.
    if (!canResolve) {
      setError(incompleteHint ?? 'That choice is not valid.')
      return
    }
    const result = resolveClarification(
      intent,
      runsWithDefault
        ? { geographies, metricKeys: [...metricKeys, DOMAIN_DEFAULT_MEASURE] }
        : { geographies, metricKeys },
    )
    if (result.ok) {
      setError('')
      onResolve(result.intent)
      return
    }
    setError(ERROR_COPY[result.error] ?? 'That choice is not valid.')
  }

  return (
    <section aria-label="Clarify the request" className="mt-4">
      <p className="text-sm text-slate-700">
        {intent.geographies.length === 0
          ? 'Choose a place and a measure before anything runs — or just a measure, to screen the whole country by it.'
          : 'Choose the place and measure before anything runs.'}
      </p>
      {/*
        Panel-reads-its-parse (P3 step 8, battery E6): the places the
        parse already holds are choices already made, shown as such.
        The shipped panel filtered candidates against the parse and
        then printed "No candidate places for this request" directly
        under a parse carrying geographies (["Hilo, HI"] in E6) — the
        copy contradicted the state it sat under. The no-candidates
        line now renders only when the parse holds no places at all.
      */}
      {intent.geographies.length > 0 && (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Choices already made</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {intent.geographies.map((place) => (
              <span
                key={place}
                className="inline-flex min-h-[44px] items-center rounded-full border border-slate-900 bg-slate-100 px-3 py-2 text-sm text-slate-900"
              >
                {place}
              </span>
            ))}
          </div>
        </div>
      )}
      {places.length > 0 ? (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Places</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {places.map((place) => (
              <button
                key={place}
                type="button"
                aria-pressed={geographies.includes(place)}
                onClick={() => togglePlace(place)}
                className={
                  geographies.includes(place)
                    ? 'min-h-[44px] rounded-full border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                    : 'min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                }
              >
                {place}
              </button>
            ))}
          </div>
        </div>
      ) : intent.geographies.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700">
          {'No candidate places for this request — pick a measure below to screen the whole country by it.'}
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-700">
          {'No further candidate places — use the measures below and the choices already made.'}
        </p>
      )}
      {metrics.length > 0 ? (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Measures</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {metrics.map((metric) => (
              <button
                key={metric}
                type="button"
                aria-pressed={metricKeys.includes(metric)}
                onClick={() => toggleMetric(metric)}
                className={
                  metricKeys.includes(metric)
                    ? 'min-h-[44px] rounded-full border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                    : 'min-h-[44px] rounded-full border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900'
                }
              >
                {measureLabel(metric)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" disabled={!canResolve} onClick={resolve} className="btn-primary mt-3">
        Use these choices
      </button>
      {incompleteHint ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          {incompleteHint}
        </p>
      ) : null}
      {error ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          {error}
        </p>
      ) : null}
    </section>
  )
}
