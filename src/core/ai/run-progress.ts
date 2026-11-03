/**
 * Run progress: the typed, code-rendered account of a research run
 * while it is still gathering (Lane A7, owner directive 2026-11-03:
 * a status update roughly every 30 seconds in plain words, data
 * streaming into the presentation as it arrives, a percent-complete
 * bar where — and only where — a real total exists, and an explicit
 * COMPLETE line when the run lands).
 *
 * The discipline this module exists to hold:
 * - The only denominator is RESEARCH PASSES. The pass count is fixed
 *   by the criterion decomposition before research starts (one pass
 *   per non-decomposed researched criterion), so the percent is a
 *   real fraction of planned work — never estimated from elapsed
 *   time, never interpolated between pass boundaries, and never
 *   shown when the total is null or 0 (the flexible and general
 *   lanes run Jev loops whose round count is unknowable until they
 *   exit; those shapes carry no snapshot and no percent, by design).
 * - A snapshot carries typed judgment data only: candidate place
 *   names + ZCTAs and per-place, per-criterion verdict classes
 *   derived deterministically from the accumulated claims by the
 *   same attribution compose uses (the pipeline injects compose's
 *   own helpers — see deriveInterimPlaces). No prose, no Census
 *   figures, no conclusion: an interim figure would frame data as
 *   the answer before the answer exists, and research narration
 *   never renders (the Texas specimen's leak, cured in A6).
 * - A failed pass counts as completed work (it terminated) and is
 *   named as a lookup that did not return, exactly as the terminal
 *   accounting names it. Percent measures work completed, never
 *   outcome success.
 *
 * Everything here is pure: the pipeline builds snapshots at pass
 * boundaries, the store holds the latest, and the status component
 * renders a function of (snapshot, stage, elapsed bucket).
 */

import type { ResearchCriterion, ResearchedClaim } from './answer'

/** One criterion's interim state for one place. */
export type InterimVerdictState = 'served' | 'not-served' | 'failed' | 'pending'

export interface InterimPlaceVerdict {
  /** The criterion's reader-facing label (the pass's own words). */
  criterion: string
  state: InterimVerdictState
}

/** One candidate place and what the passes so far say about it. */
export interface InterimPlace {
  name: string
  zcta: string
  verdicts: InterimPlaceVerdict[]
}

/**
 * The run's progress at one pass boundary. Emitted by the pipeline
 * when research begins (doneUnits 0, the candidate set as known at
 * that point) and after every pass, then held by the session store
 * until the stage clears at the terminal.
 */
export interface RunProgressSnapshot {
  /** Passes terminated (returned or tolerated-failed). */
  doneUnits: number
  /** Passes planned, or null when the shape has no honest total. */
  totalUnits: number | null
  /** Researched criteria planned (the checks the run will make). */
  criteriaTotal: number
  /** Labels of criteria whose pass returned material. */
  criteriaDone: string[]
  /** Labels of criteria whose pass failed (a lookup that did not return). */
  criteriaFailed: string[]
  /** Candidate places known so far, with their interim verdicts. */
  places: InterimPlace[]
}

/** A place's aggregate standing over the criteria assessed so far. */
export type InterimVerdictClass = 'meets' | 'does-not-meet' | 'mixed' | 'awaiting'

/**
 * Percent complete over passes, or null when no honest percent
 * exists (no snapshot total, or a total of 0). Floored, so the bar
 * reaches 100 only when the final pass has terminated.
 */
export function progressPercent(snapshot: RunProgressSnapshot): number | null {
  if (snapshot.totalUnits === null || snapshot.totalUnits <= 0) return null
  const done = Math.max(0, Math.min(snapshot.doneUnits, snapshot.totalUnits))
  return Math.floor((100 * done) / snapshot.totalUnits)
}

/**
 * The attribution the verdict derivation reads claims through. The
 * pipeline passes compose's own helpers (claimServesCriterion /
 * claimMentionsPlace from answer.ts), so an interim "served" is the
 * same judgment the terminal card's evidence lines are built from —
 * scored once, rendered by code; injected here so this module holds
 * no runtime dependency on the pipeline module.
 */
export interface ProgressAttribution {
  servesCriterion(claim: ResearchedClaim, criterion: ResearchCriterion): boolean
  mentionsPlace(claim: ResearchedClaim, place: { name: string; zcta: string }): boolean
}

/**
 * Derive interim places: for each candidate, one verdict per
 * researched criterion — 'failed' when that criterion's pass failed,
 * 'pending' when its pass has not run yet, 'served' when a claim
 * serving the criterion mentions the place, else 'not-served' (the
 * pass completed and no serving claim mentions the place — the
 * design's own definitions, DESIGN.md "Progressive render contract").
 */
export function deriveInterimPlaces(
  input: {
    claims: readonly ResearchedClaim[]
    /** The researched (non-decomposed) criteria, in pass order. */
    criteria: readonly ResearchCriterion[]
    /** Labels of criteria whose pass has terminated (returned or failed). */
    assessedLabels: readonly string[]
    /** Labels of criteria whose pass failed. */
    failedLabels: readonly string[]
    candidates: readonly { name: string; zcta: string }[]
  },
  attribution: ProgressAttribution,
): InterimPlace[] {
  const assessed = new Set(input.assessedLabels)
  const failed = new Set(input.failedLabels)
  return input.candidates.map((candidate) => ({
    name: candidate.name,
    zcta: candidate.zcta,
    verdicts: input.criteria.map((criterion) => {
      let state: InterimVerdictState
      if (failed.has(criterion.label)) {
        state = 'failed'
      } else if (!assessed.has(criterion.label)) {
        state = 'pending'
      } else if (
        input.claims.some(
          (claim) =>
            attribution.servesCriterion(claim, criterion) &&
            attribution.mentionsPlace(claim, candidate),
        )
      ) {
        state = 'served'
      } else {
        state = 'not-served'
      }
      return { criterion: criterion.label, state }
    }),
  }))
}

/**
 * Aggregate one place's verdicts into its map class. Precedence:
 * nothing assessed yet is 'awaiting'; a place both served and
 * not-served across assessed criteria is 'mixed'; any assessed
 * not-served (with no served beside it) is 'does-not-meet' — it
 * already fails a stated check; a failed criterion in an otherwise
 * served set is 'mixed', never 'meets' — the check did not return,
 * so the standing is not clean; all assessed served is 'meets'.
 */
export function aggregateVerdictClass(place: InterimPlace): InterimVerdictClass {
  const assessed = place.verdicts.filter((v) => v.state !== 'pending')
  if (assessed.length === 0) return 'awaiting'
  const served = assessed.some((v) => v.state === 'served')
  const notServed = assessed.some((v) => v.state === 'not-served')
  const failed = assessed.some((v) => v.state === 'failed')
  if (served && notServed) return 'mixed'
  if (notServed) return 'does-not-meet'
  if (failed) return 'mixed'
  return 'meets'
}

/** The reader-facing words for an aggregate verdict class. */
export function verdictClassLabel(cls: InterimVerdictClass): string {
  switch (cls) {
    case 'meets':
      return 'meets the checks so far'
    case 'does-not-meet':
      return 'does not meet the checks so far'
    case 'mixed':
      return 'mixed so far'
    case 'awaiting':
      return 'awaiting assessment'
  }
}

/**
 * Elapsed time in 30-second buckets, in plain words, or null before
 * the first bucket (the ~30s cadence: the clause joins at about half
 * a minute into a stage and changes only on bucket boundaries, so
 * the reader is never watching churn). Buckets: 1 = about half a
 * minute, 2 = about a minute, 3 = about a minute and a half, then
 * whole and half minutes by numeral.
 */
export function elapsedBucketText(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 30_000) return null
  const bucket = Math.floor(elapsedMs / 30_000)
  if (bucket === 1) return 'about half a minute in'
  if (bucket === 2) return 'about a minute in'
  if (bucket === 3) return 'about a minute and a half in'
  const whole = Math.floor(bucket / 2)
  return bucket % 2 === 1
    ? `about ${whole} and a half minutes in`
    : `about ${whole} minutes in`
}

function lookupPhrase(count: number): string {
  return count === 1 ? '1 lookup did not return' : `${count} lookups did not return`
}

function placesNamedPhrase(count: number): string {
  return count === 1 ? '1 place named so far' : `${count} places named so far`
}

/**
 * The progress block's text line: checks completed over checks
 * planned, the places named so far, and any failed lookup named in
 * plain words. "Checks done" counts passes COMPLETED — the
 * progress bar's own numerator (doneUnits): a pass whose lookup
 * failed is completed work, and the failure is named by the lookup
 * clause beside the count, never hidden inside it. Pure function
 * of the snapshot.
 */
export function progressStatusText(snapshot: RunProgressSnapshot): string {
  const total = snapshot.totalUnits ?? snapshot.criteriaTotal
  const parts = [
    `${snapshot.doneUnits} of ${total} checks done`,
    placesNamedPhrase(snapshot.places.length),
  ]
  if (snapshot.criteriaFailed.length > 0) {
    parts.push(lookupPhrase(snapshot.criteriaFailed.length))
  }
  return parts.join(' · ')
}

/**
 * The situational line the status component renders: with a snapshot
 * it is the progress status text, joined by the elapsed bucket once
 * the current stage has run about half a minute or more; without a
 * snapshot (the flexible/general lanes, a pure screen) it is the
 * elapsed bucket alone, and null before the first bucket — those
 * shapes show the stage line only until the wait is long enough for
 * a situational update to say anything.
 */
export function situationalText(
  snapshot: RunProgressSnapshot | null,
  stageElapsedMs: number,
): string | null {
  const bucket = elapsedBucketText(stageElapsedMs)
  if (snapshot) {
    const status = progressStatusText(snapshot)
    return bucket ? `${status} · ${bucket}` : status
  }
  return bucket
}

/**
 * The COMPLETE strip's text, stamped at the terminal for a run that
 * carried a progress snapshot. "Complete" describes the RUN
 * finishing, never the outcome succeeding: failed lookups are named
 * as lookups that did not return, and the places clause appears only
 * when places were actually assessed (a total failure assessed
 * none, however many candidates were waiting).
 */
export function runSummaryText(snapshot: RunProgressSnapshot): string {
  const total = snapshot.totalUnits ?? snapshot.criteriaTotal
  const done = snapshot.doneUnits
  const failed = snapshot.criteriaFailed.length
  const parts = [`Complete — ${done} of ${total} checks done`]
  if (failed > 0) parts.push(lookupPhrase(failed))
  if (snapshot.places.length > 0 && snapshot.criteriaDone.length > 0) {
    parts.push(
      snapshot.places.length === 1
        ? '1 place assessed'
        : `${snapshot.places.length} places assessed`,
    )
  }
  return parts.join(' · ')
}
