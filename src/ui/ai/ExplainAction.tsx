import { useEffect, useState } from 'react'
import { isKnownFigureKey } from '../../core/ai/intent-schema'
import { MAX_EXPLAIN_VALUES, type ExplainRequest, type MuseProvider } from '../../core/ai/provider'
import { diagnostics, ERROR_STATES, type ErrorState, type WithholdClass } from '../../core/ai/diagnostics'
import { isSuppressedFigure, realValidator } from '../../core/ai/validator'
import { ExplainBox, type ExplanationState } from './ExplainBox'
import type { FigureInput } from './FigureCard'

export function valuesForExplanation(figures: readonly FigureInput[]): ExplainRequest['values'] {
  return figures
    .filter((figure) => isKnownFigureKey(figure.key))
    .slice(0, MAX_EXPLAIN_VALUES)
    .map((figure) => {
      const suppressed = isSuppressedFigure({
        key: figure.key,
        value: figure.value,
        marginOfError: figure.marginOfError,
        suppressed: figure.suppressed,
      })
      return {
        key: figure.key,
        value: suppressed ? null : figure.value,
        marginOfError: suppressed ? undefined : figure.marginOfError,
        label: figure.label,
      }
    })
}

export async function requestValidatedExplanation(
  provider: MuseProvider,
  figureSetId: string,
  figures: readonly FigureInput[],
): Promise<{
  explanation?: ExplanationState
  message?: string
  withholdClass?: WithholdClass
  errorState?: ErrorState
}> {
  const values = valuesForExplanation(figures)
  if (values.length === 0 || values.every((figure) => figure.value === null)) {
    return { message: 'No reportable figures are available to explain.' }
  }

  try {
    const result = await provider.explain(
      { figureSetId, values },
      new AbortController().signal,
    )
    // A withheld verdict is the proxy's own validator refusing the prose. It is
    // not an absence and must not read as one, so it becomes a withheld state
    // before the empty-prose check below.
    if (result?.withheld) {
      return {
        explanation: { withheld: true },
        withholdClass: result.withholdClass ?? 'unspecified',
      }
    }
    if (typeof result?.prose !== 'string' || result.prose.trim() === '') {
      return { message: 'The wording helper returned no explanation.' }
    }
    const verdict = realValidator.validate(result.prose, values)
    if (!verdict.pass) {
      return { explanation: { withheld: true }, withholdClass: verdict.failure }
    }
    return { explanation: { prose: result.prose } }
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    const errorState: ErrorState =
      typeof code === 'string' && (ERROR_STATES as readonly string[]).includes(code)
        ? (code as ErrorState)
        : 'unexpected'
    return {
      message: 'Explanation is unavailable right now. The figures remain available.',
      errorState,
    }
  }
}

/** Error states worth one automatic wait-and-retry (see requestValidatedExplanationWithRetry). */
const AUTO_RETRYABLE: ReadonlySet<string> = new Set([
  'breaker_open',
  'provider_down',
  'rate_limited',
])

export interface ExplainRetryOptions {
  /** Delay before the single automatic retry; tests inject ~0. */
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Explanation with exactly one automatic retry on the transient failure
 * classes, mirroring requestBriefingPack and AutoExplain's posture (same
 * error set, same 15 s wait). The retry is a fresh whole request, which
 * is the layer that helps against the failure measured live on
 * 2026-11-02: a single request failed closed as breaker_open in ~1 s
 * while a concurrent sibling request succeeded — a one-request bad draw,
 * not an outage. A genuinely down upstream still ends at the same honest
 * unavailable outcome after the second attempt. Withheld prose never
 * retries: a refused figure must stay refused. The manual Explain
 * buttons in data views use this wrapper; the Ask surface keeps calling
 * requestValidatedExplanation directly because AutoExplain already
 * retries once at the component level.
 */
export async function requestValidatedExplanationWithRetry(
  provider: MuseProvider,
  figureSetId: string,
  figures: readonly FigureInput[],
  options: ExplainRetryOptions = {},
): Promise<{
  explanation?: ExplanationState
  message?: string
  withholdClass?: WithholdClass
  errorState?: ErrorState
}> {
  const first = await requestValidatedExplanation(provider, figureSetId, figures)
  if (!first.errorState || !AUTO_RETRYABLE.has(first.errorState)) return first
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  await sleep(options.retryDelayMs ?? 15_000)
  return requestValidatedExplanation(provider, figureSetId, figures)
}

export function ExplainAction({
  title,
  figureSetId,
  figures,
  provider,
}: {
  title: string
  /** Stable surface name only; this must not contain the reader's search text. */
  figureSetId: string
  figures: readonly FigureInput[]
  provider: MuseProvider
}) {
  const values = valuesForExplanation(figures)
  const fingerprint = JSON.stringify({ figureSetId, values })
  const [busy, setBusy] = useState(false)
  const [explanation, setExplanation] = useState<ExplanationState | undefined>()
  const [message, setMessage] = useState<string | undefined>()

  useEffect(() => {
    setExplanation(undefined)
    setMessage(undefined)
  }, [fingerprint])

  if (values.length === 0 || values.every((figure) => figure.value === null)) return null

  async function explain() {
    setBusy(true)
    setExplanation(undefined)
    setMessage(undefined)
    const result = await requestValidatedExplanationWithRetry(provider, figureSetId, figures)
    // Counts only, in this browser: never the prose, the figures, or the error text.
    if (result.withholdClass) diagnostics.recordWithhold(result.withholdClass)
    if (result.errorState) diagnostics.recordErrorState(result.errorState)
    if (result.explanation) setExplanation(result.explanation)
    if (result.message) setMessage(result.message)
    setBusy(false)
  }

  return (
    <section aria-label={`${title} explanation`}>
      {figures.length > MAX_EXPLAIN_VALUES && (
        <p className="text-xs text-slate-600">
          This explanation uses the first {MAX_EXPLAIN_VALUES} figures in this view.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void explain()}
        className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
      >
        {busy ? 'Explaining…' : `Explain ${title}`}
      </button>
      {message && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {message}
        </p>
      )}
      {explanation && (
        <ExplainBox
          title={`${title} explanation`}
          prose={explanation.prose}
          withheld={explanation.withheld}
        />
      )}
    </section>
  )
}
