import type { ValidatedIntent } from '../../core/ai/provider'
import { ExplainBox } from './ExplainBox'

export interface ExplanationState {
  prose?: string | null
  withheld?: boolean
}

/** Explanation action and result on the Ask surface, after clarification. */
export function ExplainOnAsk({
  intent,
  explanation,
  onExplain,
}: {
  intent: ValidatedIntent
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
