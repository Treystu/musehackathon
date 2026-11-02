import type { GeneralAnswerData } from './general-runner'

/**
 * The general lane's rendering (plan C13 refinement): the answer
 * column's own labeled class for a genuinely off-domain question.
 *
 * Beat 1 renders under ONE quiet label line — the model's own
 * answer, outside the Census data — with the answer text as written
 * (number first for Fermi shapes; the derivation and assumptions
 * are the prose's own clauses). A precision limit, when the J-GEN
 * loop shipped below bar after its round cap, renders as one clause
 * under the answer. Beat 2 renders exactly one inquiry block when
 * the runner produced one — a specific bridge or the open question
 * only — and nothing when the session already asked or was waved
 * off.
 *
 * This component renders general-class prose only. It takes no
 * ComposedAnswer, so a data answer cannot render under the general
 * label here; and no data surface takes a GeneralAnswerData, so a
 * general answer cannot render under the Census label there. The
 * separation is in the types, not just the copy.
 */
export function GeneralAnswer({ answer }: { answer: GeneralAnswerData }) {
  return (
    <section
      aria-label="General answer"
      data-prose-class={answer.proseClass}
      className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-[0_1px_6px_rgba(32,33,36,0.14)]"
    >
      <p className="text-xs font-medium text-slate-500">{answer.label}</p>
      <p className="mt-2 text-base leading-relaxed text-slate-800">{answer.text}</p>
      {answer.precisionLimit && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          {answer.precisionLimit}
        </p>
      )}
      {answer.inquiry && (
        <div className="mt-4 border-t border-slate-100 pt-3" data-inquiry={answer.inquiry.kind}>
          <p className="text-sm leading-relaxed text-slate-700">{answer.inquiry.text}</p>
        </div>
      )}
    </section>
  )
}
