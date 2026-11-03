import {
  EVIDENCE_CLASS_LABELS,
  type FlexibleAnswer as FlexibleAnswerData,
  type FlexibleFigure,
} from '../../core/ai/flexible'
import type { AnswerSource } from '../../core/ai/answer'

/**
 * The flexible completion's rendering (2026-11-02; core contract in
 * core/ai/flexible.ts). This component takes ONLY the typed
 * flexible shape — there is no prop through which an unlabeled
 * figure or place could reach the screen — and it prints the
 * evidence-class label in plain words beside every place and every
 * figure it renders. The deterministic validator has already
 * rejected any completion whose labels are missing or whose
 * Census claims have no screened row behind them; what renders
 * here is exactly what passed.
 */

const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function formatFigureValue(figure: FlexibleFigure): string {
  const value = num.format(figure.value)
  if (!figure.unit) return value
  const tight = figure.unit.startsWith('/') || figure.unit === '%'
  return tight ? `${value}${figure.unit}` : `${value} ${figure.unit}`
}

function FigureBlock({ figure }: { figure: FlexibleFigure }) {
  return (
    <div data-evidence-class={figure.evidenceClass}>
      <dt className="figure-label">{figure.label}</dt>
      <dd className="mt-0.5 text-lg font-medium tabular-nums text-slate-900">
        {formatFigureValue(figure)}
        {figure.marginOfError !== undefined && (
          <span className="ml-1 text-xs font-normal tabular-nums text-slate-500">
            ±{num.format(Math.round(figure.marginOfError))}
          </span>
        )}
      </dd>
      <dd className="mt-0.5 text-xs text-slate-500">
        {EVIDENCE_CLASS_LABELS[figure.evidenceClass]}
        {figure.evidenceClass === 'census_measured' && figure.zcta ? ` · ZIP ${figure.zcta}` : ''}
      </dd>
      {figure.working && (
        <dd className="mt-0.5 text-xs text-slate-500">Working: {figure.working}</dd>
      )}
    </div>
  )
}

export function FlexibleAnswer({
  flexible,
  sources,
}: {
  flexible: FlexibleAnswerData
  sources: readonly AnswerSource[]
}) {
  return (
    <div data-flexible-answer="">
      <p className="mt-2 text-base leading-relaxed text-slate-800">{flexible.prose}</p>
      {flexible.places.map((place) => (
        <article
          key={place.name}
          data-evidence-class={place.evidenceClass}
          className="mt-4 border-t border-slate-100 pt-4"
        >
          <h3 className="text-lg font-semibold leading-snug text-slate-900">{place.name}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {EVIDENCE_CLASS_LABELS[place.evidenceClass]}
          </p>
          {place.note && (
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{place.note}</p>
          )}
          {place.figures.length > 0 && (
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-3">
              {place.figures.map((figure, i) => (
                <FigureBlock key={`${figure.label}-${i}`} figure={figure} />
              ))}
            </dl>
          )}
        </article>
      ))}
      {flexible.figures.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-3 border-t border-slate-100 pt-4">
          {flexible.figures.map((figure, i) => (
            <FigureBlock key={`${figure.label}-${i}`} figure={figure} />
          ))}
        </dl>
      )}
      {sources.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sources</h3>
          <ul className="mt-1 space-y-1">
            {sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
