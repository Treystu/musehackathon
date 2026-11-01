import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import { ExplainAction } from './ExplainAction'
import { ExplainBox, type ExplanationState } from './ExplainBox'
import { FigureCard, type FigureInput } from './FigureCard'

/** Explanation action and result on the Ask surface, after clarification. */
export function ExplainOnAsk({
  intent,
  figures,
  explanation,
  onExplain,
  provider,
}: {
  intent: ValidatedIntent
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  onExplain?: (intent: ValidatedIntent) => void
  provider?: MuseProvider
}) {
  if (intent.clarificationNeeded) return null
  const intentFigures = (figures ?? []).filter(
    (figure) =>
      intent.metricKeys.includes(figure.key) &&
      (figure.geographies?.length === 0 ||
        figure.geographies?.some((geography) => intent.geographies.includes(geography))),
  )
  if (!onExplain && !explanation && !(provider && intentFigures.length > 0)) return null
  return (
    <section aria-label="Explain these figures">
      {provider && intentFigures.length > 0 ? (
        <ExplainAction
          title="these figures"
          figureSetId="ask"
          figures={intentFigures}
          provider={provider}
        />
      ) : onExplain ? (
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
