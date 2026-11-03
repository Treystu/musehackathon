/**
 * Hourglass bookend outcome counters (C11, 2026-11-02).
 *
 * Aggregate counts only, matching the diagnostics posture: no
 * question text, no per-reader data. The counters live in-isolate,
 * like the fallback meter, so a cold isolate starts at zero and the
 * diagnostics surface reports what this isolate has seen; the flat
 * diagnostics record gains them as one additive `hourglass` object.
 *
 * P7 (2026-11-02): the plan/verify routes now ALSO mirror every
 * outcome into the meter store (accountTopBookend /
 * accountBottomBookend in src/server/muse-proxy.ts), and
 * diagnostics reports the meter's copy when it is readable -- that
 * copy is durable and shared across isolates, which cures the
 * undercount this in-isolate view has across cold isolates.
 *
 * Item 2 cure (2026-11-03): the meter mirror now carries the
 * last-settle record durably too (BookendLastSettleMap below,
 * threaded through meter.ts / usage.ts / meter-persistence.ts),
 * so diagnostics no longer has to read last-settle from this
 * isolate's memory -- a value production could never observe,
 * because the isolate that settled last is rarely the isolate
 * serving the diagnostics read. This module remains as the
 * fallback view for a deployment (or a read) with no readable
 * meter store, and as the hermetic test surface.
 */

export interface BookendCounters {
  top: { sound: number; unsound: number; degraded: number }
  bottom: { verified: number; concerns: number; notRun: number }
}

const counters: BookendCounters = {
  top: { sound: 0, unsound: 0, degraded: 0 },
  bottom: { verified: 0, concerns: 0, notRun: 0 },
}

/**
 * Last-bookend attribution (Lane completion K4, harness item H2's
 * lane side, 2026-11-03). The aggregate counts above could not
 * answer the R21 F4 question — the bookends visibly executed on
 * the app path while the counts read plan 0 / verify 2 in every
 * diagnostics read — because a count carries no WHEN and no WHICH
 * isolate settled last. Each settle now also records the latest
 * settle per bookend: an ISO timestamp and a settle class.
 * 'settled-ok' means a verdict landed (any verdict, including
 * unsound/concerns); 'settled-error' means the call ran but
 * produced no verdict (unparseable reply, timeout, provider
 * failure); 'skipped' means the bookend never ran (no stage
 * provider configured). This module's copy is per-isolate by
 * nature, like these counters; since the Item 2 cure
 * (2026-11-03) the meter mirror carries the same record durably
 * (BookendLastSettleMap), and diagnostics exposes the durable
 * copy beside the counts when the meter view is readable, with
 * this in-isolate record as the fallback. A null entry means no
 * settle has been recorded in the view being read — itself the
 * attribution signal when the counts and the app disagree.
 */
export type BookendSettleClass = 'settled-ok' | 'settled-error' | 'skipped'

export interface BookendLastSettle {
  at: string
  settle: BookendSettleClass
}

/**
 * The last-settle record for both bookends, shared by this
 * module's in-isolate snapshot and the durable meter mirror
 * (meter.ts state, usage.ts snapshot, meter-persistence.ts
 * record): one shape, so diagnostics can swap sources without
 * changing the payload.
 */
export interface BookendLastSettleMap {
  top: (BookendLastSettle & { outcome: keyof BookendCounters['top'] }) | null
  bottom: (BookendLastSettle & { outcome: keyof BookendCounters['bottom'] }) | null
}

let lastTopSettle: (BookendLastSettle & { outcome: keyof BookendCounters['top'] }) | null = null
let lastBottomSettle: (BookendLastSettle & { outcome: keyof BookendCounters['bottom'] }) | null =
  null

export function recordTopBookend(
  outcome: keyof BookendCounters['top'],
  settle: BookendSettleClass = outcome === 'degraded' ? 'settled-error' : 'settled-ok',
): void {
  counters.top[outcome] += 1
  lastTopSettle = { at: new Date().toISOString(), outcome, settle }
}

export function recordBottomBookend(
  outcome: keyof BookendCounters['bottom'],
  settle: BookendSettleClass = outcome === 'notRun' ? 'settled-error' : 'settled-ok',
): void {
  counters.bottom[outcome] += 1
  lastBottomSettle = { at: new Date().toISOString(), outcome, settle }
}

export function bookendCountersSnapshot(): BookendCounters {
  return {
    top: { ...counters.top },
    bottom: { ...counters.bottom },
  }
}

/** The latest settle per bookend (null until this isolate settles one). */
export function bookendLastSettleSnapshot(): BookendLastSettleMap {
  return {
    top: lastTopSettle ? { ...lastTopSettle } : null,
    bottom: lastBottomSettle ? { ...lastBottomSettle } : null,
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
  lastTopSettle = null
  lastBottomSettle = null
}
