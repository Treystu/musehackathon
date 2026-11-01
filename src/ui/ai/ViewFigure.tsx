import type { MuseProvider } from '../../core/ai/provider'
import { ExplainAction } from './ExplainAction'
import { ExplainBox, type ExplanationState } from './ExplainBox'
import { FigureCard, type FigureInput } from './FigureCard'

/**
 * View-surface composition: a figure card with MOE/provenance/vintage and
 * an optional explanation box. Capability only; S11/S12 claims stay open.
 */
export function ViewFigure({
  figure,
  explanation,
  explanationTitle = 'Explanation',
  provider,
  figureSetId = 'view-figure',
}: {
  figure: FigureInput
  explanation?: ExplanationState
  explanationTitle?: string
  provider?: MuseProvider
  figureSetId?: string
}) {
  return (
    <section aria-label={`Figure ${figure.key}`}>
      <FigureCard figure={figure} />
      {provider ? (
        <ExplainAction
          title="this figure"
          figureSetId={figureSetId}
          figures={[figure]}
          provider={provider}
        />
      ) : null}
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
