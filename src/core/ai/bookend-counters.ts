/**
 * Hourglass bookend outcome counters (C11, 2026-11-02).
 *
 * Aggregate counts only, matching the diagnostics posture: no
 * question text, no per-reader data. The counters live in-isolate,
 * like the fallback meter, so a cold isolate starts at zero and the
 * diagnostics surface reports what this isolate has seen; the flat
 * diagnostics record gains them as one additive `hourglass` object.
 */

export interface BookendCounters {
  top: { sound: number; unsound: number; degraded: number }
  bottom: { verified: number; concerns: number; notRun: number }
}

const counters: BookendCounters = {
  top: { sound: 0, unsound: 0, degraded: 0 },
  bottom: { verified: 0, concerns: 0, notRun: 0 },
}

export function recordTopBookend(outcome: keyof BookendCounters['top']): void {
  counters.top[outcome] += 1
}

export function recordBottomBookend(outcome: keyof BookendCounters['bottom']): void {
  counters.bottom[outcome] += 1
}

export function bookendCountersSnapshot(): BookendCounters {
  return {
    top: { ...counters.top },
    bottom: { ...counters.bottom },
  }
}

/** Test seam only; shipped code never resets a deployment's counts. */
export function resetBookendCountersForTests(): void {
  counters.top.sound = 0
  counters.top.unsound = 0
  counters.top.degraded = 0
  counters.bottom.verified = 0
  counters.bottom.concerns = 0
  counters.bottom.notRun = 0
}
