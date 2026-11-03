import { useRef, useState } from 'react'
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

/**
 * Candidate picker. The picks ARE the decision (item-16 cure C2):
 * the toggle that makes the merged set runnable runs it — there is
 * no separate confirm step re-asking for a decision the reader
 * just made. The hint line below remains as the not-runnable
 * state's carrier: it says what is still missing, and, on the F-C
 * path, discloses the default measure before anything runs.
 */
export function ClarificationPanel({
  intent,
  candidates,
  onResolve,
  onRemovePlace,
}: {
  intent: ValidatedIntent
  candidates: ClarificationCandidates
  onResolve: (next: ValidatedIntent) => void
  /**
   * Removes a parse-held place from inside the panel (item-16 cure
   * C3). Optional: hosts that do not wire it keep the held places
   * as plain labels.
   */
  onRemovePlace?: (place: string) => void
}) {
  const [geographies, setGeographies] = useState<string[]>([])
  const [metricKeys, setMetricKeys] = useState<string[]>([])
  const [error, setError] = useState('')
  // Latched once this panel has resolved: the parent unmounts the
  // panel on resolve, but a still-mounted instance (a test harness,
  // a slow parent) must never fire a second run for the same picks.
  const resolvedRef = useRef(false)

  const places = candidates.geographies.filter((g) => !intent.geographies.includes(g))
  const metrics = candidates.metricKeys.filter((k) => !intent.metricKeys.includes(k))
  const mergedGeographies = [...intent.geographies, ...geographies]
  const mergedMetricKeys = [...intent.metricKeys, ...metricKeys]
  // One answer: the merged picks run exactly when this predicate holds.
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
   * cannot complete (a one-place comparison) stays unrun.
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
  // half of the F-C defect — the reader could not tell why. Under C2
  // the hint is also the F-C disclosure line in the runnable state.
  const incompleteHint = canResolve
    ? runsWithDefault
      ? `No measure chosen, so this runs on ${measureLabel(DOMAIN_DEFAULT_MEASURE).toLowerCase()} — the cost measure this tool uses when none is named.`
      : null
    : mergedGeographies.length === 0 && mergedMetricKeys.length === 0
      ? 'Pick a place and a measure, or a measure on its own to screen the whole country.'
      : intent.mode === 'compare' && mergedGeographies.length < 2
        ? 'Comparing needs two places — pick one more place to run these choices.'
        : 'These choices cannot run yet — a place and a measure that can screen are both needed.'

  /**
   * Runs the merged picks if — and only if — they are runnable,
   * exactly once per panel instance. Called from every toggle with
   * the toggle's own resulting picks, so the deciding toggle is
   * the run.
   */
  function tryResolve(nextGeographies: string[], nextMetricKeys: string[]) {
    if (resolvedRef.current) return
    const mergedGeos = [...intent.geographies, ...nextGeographies]
    const mergedMets = [...intent.metricKeys, ...nextMetricKeys]
    const core = canResolveClarification({
      mode: intent.mode,
      geographies: mergedGeos,
      metricKeys: mergedMets,
      filters: intent.filters,
    })
    const withDefault =
      !core &&
      mergedGeos.length > 0 &&
      mergedMets.length === 0 &&
      canRun({
        mode: intent.mode,
        geographies: mergedGeos,
        metricKeys: [DOMAIN_DEFAULT_MEASURE],
        filters: intent.filters,
        clarificationNeeded: false,
      })
    if (!core && !withDefault) return
    const result = resolveClarification(
      intent,
      withDefault
        ? { geographies: nextGeographies, metricKeys: [...nextMetricKeys, DOMAIN_DEFAULT_MEASURE] }
        : { geographies: nextGeographies, metricKeys: nextMetricKeys },
    )
    if (result.ok) {
      resolvedRef.current = true
      setError('')
      onResolve(result.intent)
      return
    }
    setError(ERROR_COPY[result.error] ?? 'That choice is not valid.')
  }

  // Nothing runs at mount, by design: firing is toggle-only (the
  // audit's C2 wording — the toggle that makes the set runnable is
  // the run). A mount-fire cannot distinguish a fresh parse settling
  // into clarification from the reader's own chip removal in the
  // editor above sending the intent back here — and auto-running
  // the second case, on a default measure the reader never picked,
  // would override the removal they just made (the spec-gaps
  // chip-removal pins measure exactly that regression).

  function togglePlace(value: string) {
    const next = geographies.includes(value)
      ? geographies.filter((x) => x !== value)
      : [...geographies, value]
    setGeographies(next)
    tryResolve(next, metricKeys)
  }

  function toggleMetric(value: string) {
    const next = metricKeys.includes(value)
      ? metricKeys.filter((x) => x !== value)
      : [...metricKeys, value]
    setMetricKeys(next)
    tryResolve(geographies, next)
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
        Since C3 the held places are removable here when the host
        wires onRemovePlace — they used to be inert labels whose
        only removal path was the editor mounted above the panel.
      */}
      {intent.geographies.length > 0 && (
        <div className="mt-2">
          <span className="text-sm font-medium text-slate-900">Choices already made</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {intent.geographies.map((place) =>
              onRemovePlace ? (
                <button
                  key={place}
                  type="button"
                  aria-label={`Remove place ${place}`}
                  onClick={() => onRemovePlace(place)}
                  className="inline-flex min-h-[44px] items-center rounded-full border border-slate-900 bg-slate-100 px-3 py-2 text-sm text-slate-900 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                >
                  {place} ×
                </button>
              ) : (
                <span
                  key={place}
                  className="inline-flex min-h-[44px] items-center rounded-full border border-slate-900 bg-slate-100 px-3 py-2 text-sm text-slate-900"
                >
                  {place}
                </span>
              ),
            )}
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
