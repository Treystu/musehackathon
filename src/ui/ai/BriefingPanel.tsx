import { ExplainBox } from './ExplainBox'

export interface BriefingPanelState {
  prose?: string | null
  withheld?: boolean
  /** Plain-words failure from the route (e.g. a figure failed source
   * verification). Shown as-is; never carries provider detail. */
  error?: string
}

/**
 * Briefing pack entry for the current view: one action, then the pack
 * prose (or its withholding) with the standing disclosure, through
 * the same ExplainBox every other AI surface uses.
 */
export function BriefingPanel({
  briefing,
  onBrief,
}: {
  briefing?: BriefingPanelState
  onBrief?: () => void
}) {
  if (!onBrief && !briefing) return null
  return (
    <section aria-label="Briefing pack">
      {onBrief ? (
        <button type="button" onClick={() => onBrief()} className="btn-secondary">
          Brief this view
        </button>
      ) : null}
      {briefing?.error ? (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {briefing.error}
        </p>
      ) : null}
      {briefing && !briefing.error ? (
        <ExplainBox
          title="Briefing pack"
          prose={briefing.prose}
          withheld={briefing.withheld}
        />
      ) : null}
    </section>
  )
}
