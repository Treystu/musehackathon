import type { ValidatedIntent } from '../../core/ai/provider'
import type { AskSessionStore } from './session-store'

/**
 * H3 chained refinement (Hail-Mary, 2026-11-05): a criteria-only /
 * fragmentary follow-up composes against the session's standing
 * screen instead of starting a fresh placeless parse.
 *
 * The standing screen is the last landed answer request's intent
 * (the screen that produced the card on screen). Panel intent is
 * not used: it clears at every ask start, while the answer request
 * survives until the next request mints.
 */

export interface StandingScreen {
  geographies: string[]
  metricKeys: string[]
  filters: ValidatedIntent['filters']
  mode: ValidatedIntent['mode']
}

/** Read the standing screen from the session, if any landed answer exists. */
export function standingScreenFromSession(session: AskSessionStore): StandingScreen | null {
  const req = session.getSnapshot().answer.request
  const intent = req?.intent
  if (!intent) return null
  if (intent.geographies.length === 0 && intent.metricKeys.length === 0 && intent.filters.length === 0) {
    return null
  }
  return {
    geographies: [...intent.geographies],
    metricKeys: [...intent.metricKeys],
    filters: intent.filters.map((f) => ({ ...f })),
    mode: intent.mode,
  }
}

const FRAGMENT_SIGNALS = ['also', 'and also', 'plus', 'near', 'within', 'miles of', 'walmart', 'target', 'costco']

/**
 * Fragment gate: true when a standing screen exists and the follow-up
 * reads as criteria-only — it names none of the standing geography
 * and carries a fragment signal (also/near/within/POI) or is short
 * with no geography-like content. Deterministic and lexical; the
 * fresh-question path (naming a new place, or no standing) stays false.
 */
export function isFragmentFollowUp(queryText: string, standing: StandingScreen | null): boolean {
  if (!standing) return false
  const lower = queryText.toLowerCase()
  const namesStanding = standing.geographies.some((g) => g.length > 0 && lower.includes(g.toLowerCase()))
  if (namesStanding) return false
  const hasSignal = FRAGMENT_SIGNALS.some((s) => lower.includes(s))
  if (hasSignal) return true
  // Short criteria-only follow-ups without a place name (e.g. "under $1500")
  // still refine when a screen stands; a fresh full question names a place.
  if (queryText.trim().length < 80 && !lower.includes(' in ') && !lower.includes(',')) return true
  return false
}

/** Merge a fragmentary parse against the standing screen (no silent drops). */
export function mergeFragmentIntent(
  parsed: ValidatedIntent,
  standing: StandingScreen,
  queryText: string,
): ValidatedIntent {
  const geographies =
    parsed.geographies.length > 0 ? [...parsed.geographies] : [...standing.geographies]
  const metricKeys = [...new Set([...standing.metricKeys, ...parsed.metricKeys])]
  const seen = new Set<string>()
  const filters: ValidatedIntent['filters'] = []
  for (const f of [...standing.filters, ...parsed.filters]) {
    const key = `${f.metricKey}|${f.op}|${f.value}`
    if (seen.has(key)) continue
    seen.add(key)
    filters.push({ ...f })
  }
  // A fragment that parsed as lookup with no geography refines the
  // standing sweep rather than opening a placeless lookup.
  const mode =
    parsed.mode === 'sweep_filter' || standing.mode === 'sweep_filter' ? 'sweep_filter' : parsed.mode
  void queryText
  return { ...parsed, geographies, metricKeys, filters, mode }
}
