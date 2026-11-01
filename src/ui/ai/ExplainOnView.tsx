import { useState } from 'react'
import {
  EXPLAIN_VIEW_LABELS,
  explainView,
  type ExplainViewClass,
  type ViewExplanation,
} from '../../core/ai/explain-view'
import type { MuseProvider } from '../../core/ai/provider'
import { hermeticStubValidator, type Validator } from '../../core/ai/validator'
import { ExplainBox } from './ExplainBox'
import type { ExplanationState } from './ExplainBox'
import { FigureCard, type FigureInput } from './FigureCard'

/**
 * Explanation action and result on any non-Ask view (drilldown,
 * comparison, sweep, map selection, saved view, similarity). Mirrors
 * ExplainOnAsk's composition — figures behind the explanation plus the
 * shared ExplainBox with its standing disclosure — but the request is
 * driven by the view's own figure set through explainView, so the prose
 * is validator-gated before it renders, exactly as on Ask.
 */
export function ExplainOnView({
  viewClass,
  figures,
  provider,
  validator = hermeticStubValidator,
  title = 'Explanation',
}: {
  viewClass: ExplainViewClass
  figures: readonly FigureInput[]
  provider: MuseProvider
  validator?: Validator
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  const [explanation, setExplanation] = useState<ViewExplanation | null>(null)
  if (figures.length === 0) return null

  async function run() {
    if (busy) return
    setBusy(true)
    try {
      setExplanation(await explainView(provider, validator, viewClass, figures))
    } finally {
      setBusy(false)
    }
  }

  const state: ExplanationState | undefined = explanation
    ? { prose: explanation.prose, withheld: explanation.withheld }
    : undefined

  return (
    <section
      aria-label={`Explain this ${EXPLAIN_VIEW_LABELS[viewClass].toLowerCase()} view`}
    >
      <button type="button" disabled={busy} onClick={run}>
        Explain these figures
      </button>
      {explanation ? (
        <>
          <section aria-label="Figures behind this explanation">
            {figures.map((figure, index) => (
              <FigureCard key={`${figure.key}-${index}`} figure={figure} />
            ))}
          </section>
          <ExplainBox
            title={title}
            prose={state?.prose}
            withheld={state?.withheld}
          />
        </>
      ) : null}
    </section>
  )
}
