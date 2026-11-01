import { useEffect, useState } from 'react'
import {
  BriefingVerificationError,
  generateBriefingPack,
  type BriefingPack,
  type BriefingPackRequest,
  type FigureMismatch,
  type FigureResolver,
} from '../../core/ai/briefing'
import { diagnostics, ERROR_STATES, type ErrorState, type WithholdClass } from '../../core/ai/diagnostics'
import { answerMethodologyQuestion, type QaResult } from '../../core/ai/methodology-qa'
import type { MuseProvider } from '../../core/ai/provider'
import { DISCLOSURE_TEXT } from '../../core/ai/validator'
import { ExplainBox } from './ExplainBox'
import type { BriefingFigure } from '../../core/ai/briefing'

export interface BriefingOutcome {
  pack?: BriefingPack
  /** Re-verification failures: generation refused, loudly, per figure. */
  verificationFailures?: readonly FigureMismatch[]
  message?: string
  withholdClass?: WithholdClass
  errorState?: ErrorState
}

/**
 * Pack generation as one call, mirroring requestValidatedExplanation:
 * verification failure is a distinct outcome from a provider error,
 * because the reader must see WHICH figure failed its source check.
 */
export async function requestBriefingPack(
  provider: MuseProvider,
  req: BriefingPackRequest,
  resolveFigure: FigureResolver,
): Promise<BriefingOutcome> {
  try {
    const pack = await generateBriefingPack(req, { provider, resolveFigure })
    return {
      pack,
      withholdClass: pack.narrativeWithheld
        ? (pack.withholdClass ?? 'unspecified')
        : undefined,
    }
  } catch (e) {
    if (e instanceof BriefingVerificationError) {
      return { verificationFailures: e.mismatches }
    }
    const code = (e as { code?: unknown } | null)?.code
    const errorState: ErrorState =
      typeof code === 'string' && (ERROR_STATES as readonly string[]).includes(code)
        ? (code as ErrorState)
        : 'unexpected'
    return {
      message: 'Briefing pack is unavailable right now. The figures remain available.',
      errorState,
    }
  }
}

export function BriefingPackView({ pack }: { pack: BriefingPack }) {
  return (
    <section aria-label="Briefing pack" className="mt-4">
      <h3 className="text-sm font-semibold text-slate-900">Briefing pack</h3>
      <p className="mt-1 text-sm text-slate-700">{pack.coverLine}</p>
      <ExplainBox
        title="Briefing narrative"
        prose={pack.narrative}
        withheld={pack.narrativeWithheld}
      />
      <ul className="mt-3 space-y-2 text-sm text-slate-700">
        {pack.rows.map((row) => (
          <li key={`${row.geography}-${row.key}`}>
            <strong className="text-slate-900">
              {row.geography} — {row.label}: {row.headline}
            </strong>
            <br />
            {row.provenance}
          </li>
        ))}
      </ul>
      <details className="mt-3">
        <summary className="disclosure-summary">Methodology and citations</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {pack.appendix.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      <p role="note" className="house-disclosure mt-3">
        {pack.fairHousingNote}
      </p>
      <details className="mt-2">
        <summary className="disclosure-summary">Pack as plain text</summary>
        <pre className="mt-1 overflow-auto rounded-md bg-slate-50 p-3 text-xs text-slate-800">
          {pack.text}
        </pre>
      </details>
    </section>
  )
}

export function MethodologyQa() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<QaResult | undefined>()

  function ask(event: React.FormEvent) {
    event.preventDefault()
    setResult(answerMethodologyQuestion(question))
  }

  return (
    <section aria-label="Methodology questions" className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold text-slate-900">Ask about the data</h3>
      <p className="mt-1 text-sm text-slate-700">
        Where a figure comes from, how current it is, why it is missing, what is
        covered. Questions about the figures themselves belong to search.
      </p>
      <form onSubmit={ask} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm font-medium text-slate-900">
          Methodology question
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Why is there no graduation rate for this ZIP?"
            className="field mt-1 w-full"
          />
        </label>
        <button type="submit" className="btn-secondary shrink-0">
          Ask
        </button>
      </form>
      {result && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {result.text}
        </p>
      )}
      <p role="note" className="house-disclosure mt-3">
        {DISCLOSURE_TEXT}
      </p>
    </section>
  )
}

export function BriefingView({
  provider,
  title,
  viewKind,
  places,
  figures,
  resolveFigure,
  packUrl,
}: {
  provider: MuseProvider
  title: string
  viewKind: string
  places: string[]
  figures: readonly BriefingFigure[]
  resolveFigure: FigureResolver
  packUrl?: string
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<BriefingOutcome | undefined>()

  const fingerprint = JSON.stringify(figures.map((f) => [f.key, f.geography, f.value]))
  useEffect(() => {
    // A pack describes the view it was generated from; when the view
    // changes, the old pack is stale and is dropped, not left standing.
    setOutcome(undefined)
  }, [fingerprint])

  async function generate() {
    setBusy(true)
    setOutcome(undefined)
    const result = await requestBriefingPack(
      provider,
      {
        figureSetId: 'briefing-view',
        title,
        viewKind,
        places,
        figures: [...figures],
        packUrl:
          packUrl ?? (typeof location !== 'undefined' ? location.href : undefined),
      },
      resolveFigure,
    )
    // Counts only, in this browser: never the prose, figures, or error text.
    if (result.withholdClass) diagnostics.recordWithhold(result.withholdClass)
    if (result.errorState) diagnostics.recordErrorState(result.errorState)
    setOutcome(result)
    setBusy(false)
  }

  return (
    <section aria-label="Briefing pack and methodology">
      <h2 className="text-sm font-semibold text-slate-900">Briefing pack</h2>
      <p className="mt-1 text-sm text-slate-700">
        A pack for the places you have open: every figure is re-checked against
        its source when the pack is generated, and generation refuses if any
        figure does not come back exactly as shown.
      </p>
      {figures.length === 0 ? (
        <p role="status" className="mt-2 text-sm text-slate-600">
          Open a place first — a pack is built from the figures in your view.
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          {busy ? 'Generating…' : 'Generate briefing pack'}
        </button>
      )}
      {outcome?.message && (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {outcome.message}
        </p>
      )}
      {outcome?.verificationFailures && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-900">
          <p>
            Pack refused: {outcome.verificationFailures.length} figure(s) failed
            re-verification against their sources.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {outcome.verificationFailures.map((failure) => (
              <li key={`${failure.geography}-${failure.key}`}>
                {failure.key} ({failure.geography}): {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcome?.pack && <BriefingPackView pack={outcome.pack} />}
      <MethodologyQa />
    </section>
  )
}
