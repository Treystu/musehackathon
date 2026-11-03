import { useEffect, useState, useSyncExternalStore } from 'react'
import { ThinkingIndicator } from './ThinkingIndicator'
import {
  stageLabel,
  stagedStatusVisible,
  type AskSessionStore,
} from './session-store'
import { progressPercent, situationalText } from '../../core/ai/run-progress'

/**
 * The working state with staged status (drive item 17 part b,
 * owner-live defect, 2026-11-02: a long request "seemed like it was
 * hanging" — the ack + thinking dots carried no stage information
 * over a long wait, which is why he tab-switched).
 *
 * Shape: the ack line is the conversational frame and renders for
 * as long as the parent mounts this component. The VISUAL
 * indicator — the thinking dots (which respect
 * prefers-reduced-motion through the global guard in app.css) and
 * the staged line — joins it only once the RUN passes the
 * 1-second rule (session-store's STAGED_STATUS_THRESHOLD_MS, timed
 * from the run's start, not the stage's), and only while a run's
 * stage is actually active. That gating is the indicator
 * lifecycle cure (2026-11-02): the dots previously rendered from
 * t=0 on every run and whenever a parent mounted the component
 * with no run behind it — the owner's words: the indicator was
 * "there regardless of if it's necessary, or complete." A
 * sub-second run now shows the ack alone; a mount with no active
 * stage shows the ack alone. The staged line names the stage the
 * pipeline is actually in — the store's stage advances only at
 * real stage boundaries (see session-store's StageId contract) —
 * in plain words, with no percentages and no invented
 * granularity; research names its parsed subject where the
 * pipeline supplied one.
 *
 * Accessibility: stage changes are announced through a visually
 * hidden aria-live polite region whose text is the stage label and
 * nothing else. The label is present whenever a stage is active —
 * including before the visible line's 1-second threshold — so the
 * live text changes ONLY on a stage transition: the store suppresses
 * same-stage re-sets, and neither the clock tick nor the threshold
 * crossing ever rewrites it. A long stage does not re-announce
 * itself while it runs.
 *
 * Run progress (Lane A7, owner directive 2026-11-03 02:49 HST —
 * long runs "seemed like they were hanging"): below the stage line,
 * a situational line in plain words — what has been gathered so far
 * plus, once the current stage is ~30s old, an elapsed clause —
 * and, when the pipeline has reported a research snapshot with a
 * known pass plan, a progress bar whose value is passes completed
 * over passes planned and nothing else (run-progress.ts derives
 * both; shapes with no honest percent show no bar). The block is
 * visual only: it renders outside the aria-live region and the
 * 200ms tick that refreshes it never rewrites the live text.
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
  // Progress reads (Lane A7): the snapshot's percent and the
  // situational line, both pure functions of the store's progress
  // and the current stage's age — refreshed by the same 200ms tick
  // that gates the 1-second rule, and never written into the live
  // region below.
  const progress = stage?.progress ?? null
  const percent = progress ? progressPercent(progress) : null
  const situational = stage ? situationalText(progress, session.now() - stage.stageSince) : null
  return (
    <>
      <span>{ack}</span>
      {visible && <ThinkingIndicator />}
      {visible && (
        <span className="text-slate-500" data-testid="staged-status-line">
          {label}
        </span>
      )}
      {visible && situational && (
        <span className="text-slate-500" data-testid="staged-progress-line">
          {situational}
        </span>
      )}
      {visible && percent !== null && (
        <>
          <span
            role="progressbar"
            aria-label={progress?.breadth ? 'Areas assessed' : 'Research checks complete'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-testid="staged-progress-bar"
            className="inline-block h-1.5 w-40 overflow-hidden rounded bg-slate-200 align-middle"
          >
            <span className="block h-full bg-slate-500" style={{ width: `${percent}%` }} />
          </span>
          {/*
            The percent as a visible figure beside the bar (Lane A9
            FM-13): the bar carried the number only in its width and
            its aria value, so a sighted reader got a fraction from
            the counts line but never the percent the bar asserted.
            Same floored value progressPercent computes — one
            number, two renderings.
          */}
          <span className="text-slate-500 tabular-nums" data-testid="staged-progress-percent">
            {percent}%
          </span>
        </>
      )}
      <span aria-live="polite" className="sr-only" data-testid="staged-status-live">
        {label}
      </span>
    </>
  )
}
