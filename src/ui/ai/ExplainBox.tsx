import { DISCLOSURE_TEXT } from '../../core/ai/validator'

export type ExplainState = 'withheld' | 'empty' | 'ready'

export interface ExplanationState {
  prose?: string | null
  withheld?: boolean
}

export function explainState(
  prose: string | null | undefined,
  withheld?: boolean,
): ExplainState {
  if (withheld) return 'withheld'
  if (prose == null || prose.trim() === '') return 'empty'
  return 'ready'
}

export function ExplainBox({
  title,
  prose,
  withheld,
}: {
  title: string
  prose?: string | null
  withheld?: boolean
}) {
  const state = explainState(prose, withheld)
  return (
    <section aria-label={title} className="mt-3">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {state === 'withheld' && (
        <p role="status" className="mt-1 text-sm text-slate-700">
          Explanation withheld. The figures are shown without wording.
        </p>
      )}
      {state === 'empty' && (
        <p role="status" className="mt-1 text-sm text-slate-700">
          No explanation yet.
        </p>
      )}
      {state === 'ready' && <p className="mt-1 text-sm leading-relaxed text-slate-700">{prose}</p>}
      <p role="note" className="house-disclosure mt-2">
        {DISCLOSURE_TEXT}
      </p>
    </section>
  )
}
