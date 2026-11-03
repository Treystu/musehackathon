import { useId, useState, type ReactNode } from 'react'

/**
 * The explain-nothing affordance (owner rule, 2026-11-02): the Ask
 * surface carries no explanatory prose. Anything a reader might want
 * explained lives behind this small circled question mark, revealed
 * only on request — hover or focus for pointer/keyboard, tap for
 * touch (phones have no hover, so the tap is the primary path and
 * hover is a shortcut layered on the same state).
 *
 * The panel is always in the DOM and merely hidden while closed:
 * the conformity pins assert the disclosure texts are present on the
 * surface, and a screen reader or find-in-page reaches them exactly
 * as before. Escape closes it, and a second tap unpins it, so the
 * panel never becomes the clutter it replaced.
 */
export function HelpTip({
  label,
  align = 'left',
  children,
}: {
  /** Accessible name for the button, e.g. "About the wording helper". */
  label: string
  align?: 'left' | 'right'
  children: ReactNode
}) {
  // Two open-sources, deliberately separate (measured defect, phone
  // tap test 2026-11-02): a tap fires an emulated mouseenter BEFORE
  // the click, so one shared boolean toggled by click and set by
  // hover opens on hover and instantly closes on the tap that
  // follows it. Hover/focus opens transiently; a click pins the
  // panel open (or unpins it) regardless of hover state.
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hover || pinned
  const panelId = useId()
  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHover(true)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
            setHover(false)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setPinned(false)
            setHover(false)
          }
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs font-medium text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
      >
        <span aria-hidden="true">?</span>
      </button>
      <div
        id={panelId}
        role="note"
        hidden={!open}
        className={`absolute top-8 z-30 w-72 max-w-[78vw] rounded-lg border border-slate-200 bg-white p-3 text-left text-sm leading-relaxed text-slate-600 shadow-[0_4px_16px_rgba(32,33,36,0.18)] ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </div>
    </div>
  )
}
