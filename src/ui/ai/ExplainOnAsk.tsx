import type { ValidatedIntent } from '../../core/ai/provider'
import { ExplainBox } from './ExplainBox'
import { FigureCard, type FigureInput } from './FigureCard'

export interface ExplanationState {
  prose?: string | null
  withheld?: boolean
}

/** Explanation action and result on the Ask surface, after clarification. */
export function ExplainOnAsk({
  intent,
  figures,
  explanation,
  onExplain,
}: {
  intent: ValidatedIntent
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  onExplain?: (intent: ValidatedIntent) => void
}) {
  if (intent.clarificationNeeded) return null
  if (!onExplain && !explanation) return null
  return (
    <section aria-label="Explain these figures">
      {onExplain ? (
        <button type="button" onClick={() => onExplain(intent)}>
          Explain these figures
        </button>
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
    </section>
  )
}
