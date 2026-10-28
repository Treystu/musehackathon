import { ExplainBox } from './ExplainBox'
import type { ExplanationState } from './ExplainOnAsk'
import { FigureCard, type FigureInput } from './FigureCard'

/**
 * View-surface composition: a figure card with MOE/provenance/vintage and
 * an optional explanation box. Capability only; S11/S12 claims stay open.
 */
export function ViewFigure({
  figure,
  explanation,
  explanationTitle = 'Explanation',
}: {
  figure: FigureInput
  explanation?: ExplanationState
  explanationTitle?: string
}) {
  return (
    <section aria-label={`Figure ${figure.key}`}>
      <FigureCard figure={figure} />
      {explanation ? (
        <ExplainBox
          title={explanationTitle}
          prose={explanation.prose}
          withheld={explanation.withheld}
        />
      ) : null}
    </section>
  )
}
