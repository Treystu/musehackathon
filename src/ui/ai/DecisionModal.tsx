import { useEffect, useId, useRef } from 'react'

/**
 * The async decision modal (plan C7): a small calm overlay card with
 * the specific question (C8), the branch's options as tappable rows,
 * and the quiet dismissal. role="dialog", aria-labelledby; Esc
 * dismisses. Focus is NOT moved on mount — the card lands only if the
 * reader was not mid-typing is the caller's concern at render time;
 * this component never steals focus from the Ask input (it renders
 * without autoFocus and without a focus trap), and Esc handling is
 * scoped to keydowns while it is mounted. Motion is the design
 * system's rise-in (anim-rise), which the global reduced-motion guard
 * collapses to instant.
 */
export interface DecisionModalProps {
  questionText: string
  options: readonly { id: string; label: string }[]
  dismissLabel: string
  onChoose: (optionId: string) => void
  onDismiss: () => void
}

export function DecisionModal({
  questionText,
  options,
  dismissLabel,
  onChoose,
  onDismiss,
}: DecisionModalProps) {
  const titleId = useId()
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="anim-rise mx-auto mt-4 max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-[0_2px_12px_rgba(32,33,36,0.18)]"
    >
      <p id={titleId} className="text-base font-medium text-slate-900">
        {questionText}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChoose(option.id)}
            className="min-h-[44px] rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            {option.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-sm text-slate-500 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
      >
        {dismissLabel}
      </button>
    </div>
  )
}
