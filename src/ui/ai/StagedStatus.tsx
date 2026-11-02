import { useEffect, useState, useSyncExternalStore } from 'react'
import { ThinkingIndicator } from './ThinkingIndicator'
import {
  stageLabel,
  stagedStatusVisible,
  type AskSessionStore,
} from './session-store'

/**
 * The working state with staged status (drive item 17 part b,
 * owner-live defect, 2026-11-02: a long request "seemed like it was
 * hanging" — the ack + thinking dots carried no stage information
 * over a long wait, which is why he tab-switched).
 *
 * Shape: the existing conversational frame is untouched — the ack
 * line plus the thinking indicator (whose dots already respect
 * prefers-reduced-motion through the global guard in app.css). The
 * staged line joins it only once the RUN passes the 1-second rule
 * (session-store's STAGED_STATUS_THRESHOLD_MS, timed from the run's
 * start, not the stage's): a fast run shows the ack alone, exactly
 * as before. The line names the stage the pipeline is actually in —
 * the store's stage advances only at real stage boundaries (see
 * session-store's StageId contract) — in plain words, with no
 * percentages and no invented granularity; research names its parsed
 * subject where the pipeline supplied one.
 *
 * Accessibility: stage changes are announced through a visually
 * hidden aria-live polite region whose text is the stage label and
 * nothing else. The label is present whenever a stage is active —
 * including before the visible line's 1-second threshold — so the
 * live text changes ONLY on a stage transition: the store suppresses
 * same-stage re-sets, and neither the clock tick nor the threshold
 * crossing ever rewrites it. A long stage does not re-announce
 * itself while it runs.
 */
export function StagedStatus({
  session,
  ack,
}: {
  session: AskSessionStore
  ack: string
}) {
  // Server snapshot passed as well: static renders of the Ask
  // surface include this component, and useSyncExternalStore throws
  // under server rendering without one (the store's current snapshot
  // is the honest static read).
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const stage = snapshot.stage
  // The 1-second threshold is a clock reading, not store state: tick
  // while a run is active so the staged line appears when the wait
  // crosses it even if no stage boundary happens to land there.
  const [, setTick] = useState(0)
  const runToken = stage?.runToken
  useEffect(() => {
    if (runToken === undefined || runToken === null) return
    const timer = setInterval(() => setTick((n) => n + 1), 200)
    return () => clearInterval(timer)
  }, [runToken])

  const visible = stagedStatusVisible(stage, session.now())
  const label = stage ? stageLabel(stage.stage, stage.subject) : ''
  return (
    <>
      <span>{ack}</span>
      <ThinkingIndicator />
      {visible && (
        <span className="text-slate-500" data-testid="staged-status-line">
          {label}
        </span>
      )}
      <span aria-live="polite" className="sr-only" data-testid="staged-status-live">
        {label}
      </span>
    </>
  )
}
