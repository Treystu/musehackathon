import { useEffect, useRef, useState } from 'react'

/** Error states worth one automatic wait-and-retry (see AutoExplain). */
const AUTO_RETRYABLE: ReadonlySet<string> = new Set([
  'breaker_open',
  'provider_down',
  'rate_limited',
])
import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import { diagnostics } from '../../core/ai/diagnostics'
import { requestValidatedExplanation, valuesForExplanation } from './ExplainAction'
import { ExplainBox, type ExplanationState } from './ExplainBox'
import { FigureCard, type FigureInput } from './FigureCard'

/**
 * The explanation for an executed Ask, generated automatically
 * (owner directive, 2026-11-01: type a question, get the immediate
 * comprehensive answer — figures plus the grounded prose reading of
 * them, no extra click). Fires once per distinct figure set through
 * the same validated path the manual Explain action uses, so the
 * validator, withhold, and diagnostics behavior is identical. A
 * failure shows its honest message with a retry, never silence.
 */
function AutoExplain({
  figures,
  provider,
}: {
  figures: readonly FigureInput[]
  provider: MuseProvider
}) {
  const values = valuesForExplanation(figures)
  const fingerprint = JSON.stringify(values)
  const [explanation, setExplanation] = useState<ExplanationState | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const autoRetriedFor = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    setBusy(true)
    setExplanation(undefined)
    setMessage(undefined)
    void (async () => {
      const result = await requestValidatedExplanation(provider, 'ask', figures)
      if (!live) return
      if (result.withholdClass) diagnostics.recordWithhold(result.withholdClass)
      if (result.errorState) diagnostics.recordErrorState(result.errorState)
      // Same patience as the parse path (2026-11-01): a retryable
      // failure — the helper's breaker pause or a provider flap — is
      // waited out once, automatically, before the unavailable copy
      // and the manual retry button take over.
      if (
        result.errorState &&
        AUTO_RETRYABLE.has(result.errorState) &&
        autoRetriedFor.current !== fingerprint
      ) {
        autoRetriedFor.current = fingerprint
        setTimeout(() => {
          if (live) setAttempt((n) => n + 1)
        }, 15000)
        return
      }
      if (result.explanation) setExplanation(result.explanation)
      if (result.message) setMessage(result.message)
      setBusy(false)
    })()
    return () => {
      live = false
    }
    // Figures are identified by their values fingerprint; a new set re-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, attempt])

  if (values.length === 0 || values.every((figure) => figure.value === null)) return null
  return (
    <section aria-label="Explain these figures" className="mt-3">
      {busy && (
        <p role="status" className="text-sm text-slate-600">
          Explaining these figures…
        </p>
      )}
      {message && (
        <>
          <p role="status" className="mt-2 text-sm text-slate-700">
            {message}
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="btn-secondary mt-2"
          >
            Try the explanation again
          </button>
        </>
      )}
      {explanation && (
        <ExplainBox title="Explanation" prose={explanation.prose} withheld={explanation.withheld} />
      )}
    </section>
  )
}

/**
 * Explanation on the Ask surface: one contract (item-16 cure C7) —
 * automatic after a run, always. This surface used to render a
 * manual "Explain these figures" button whenever a host wired an
 * onExplain callback, so the same act cost 0 clicks on one mount
 * and 1 on another; the audit's minimum cure is that the Ask
 * surface behaves identically regardless of wiring. The manual
 * variant is removed: with a provider and figures the explanation
 * fires on its own, and a host-supplied explanation (the
 * prop-driven result path) still renders as before. Data views
 * keep their own manual ExplainAction button, unchanged.
 */
export function ExplainOnAsk({
  intent,
  figures,
  explanation,
  provider,
}: {
  intent: ValidatedIntent
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  provider?: MuseProvider
}) {
  if (intent.clarificationNeeded) return null
  const intentFigures = (figures ?? []).filter(
    (figure) =>
      intent.metricKeys.includes(figure.key) &&
      (figure.geographies?.length === 0 ||
        figure.geographies?.some((geography) => intent.geographies.includes(geography))),
  )
  if (!explanation && !(provider && intentFigures.length > 0)) return null
  return (
    <>
      {provider && intentFigures.length > 0 && !explanation ? (
        <AutoExplain figures={intentFigures} provider={provider} />
      ) : null}
      {explanation && figures && figures.length > 0 ? (
        <section aria-label="Figures behind this explanation">
          {figures.map((figure, index) => (
            <FigureCard key={`${figure.key}-${index}`} figure={figure} />
          ))}
        </section>
      ) : null}
      {explanation ? (
        <ExplainBox
          title="Explanation"
          prose={explanation.prose}
          withheld={explanation.withheld}
        />
      ) : null}
    </>
  )
}
