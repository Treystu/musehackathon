import { DISCLOSURE_TEXT } from '../../core/ai/validator'

export type ExplainState = 'withheld' | 'empty' | 'ready'

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
    <section aria-label={title}>
      <h3>{title}</h3>
      {state === 'withheld' && (
        <p role="status">
          Explanation withheld. The figures are shown without wording.
        </p>
      )}
      {state === 'empty' && <p role="status">No explanation yet.</p>}
      {state === 'ready' && <p>{prose}</p>}
      <p role="note" className="house-disclosure">
        {DISCLOSURE_TEXT}
      </p>
    </section>
  )
}
