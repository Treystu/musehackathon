/**
 * The thinking indicator (plan C6): three dots, 6 px, accent color,
 * 1.2 s jump cycle staggered 0.15 s (the `.thinking-dot` classes in
 * app.css), inside an aria-live polite region whose quiet text
 * equivalent is "Working on it". Under prefers-reduced-motion the
 * global guard in app.css collapses the animation, so the dots render
 * static — no separate branch is needed here, and the e2e pin checks
 * the dots and the live text, not the motion.
 */
export function ThinkingIndicator() {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="inline-flex items-end gap-1">
        <span className="thinking-dot" />
        <span className="thinking-dot thinking-dot-2" />
        <span className="thinking-dot thinking-dot-3" />
      </span>
      <span className="sr-only">Working on it</span>
    </span>
  )
}
