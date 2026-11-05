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
 * Fragment gate: true only when a standing screen exists, the parsed
 * follow-up names no geography of its own, it names none of the
 * standing geography, and it carries an explicit fragment signal
 * (also/near/within/POI). Deterministic and lexical. There is
 * deliberately no length-based fallback: a short fresh question
 * with no signal (e.g. a criteria-only research question) must
 * start fresh, never silently inherit the standing screen —
 * measured 2026-11-05, when the length fallback merged a fresh
 * schools/fast-food question into the previous Hilo screen.
 */
export function isFragmentFollowUp(
  queryText: string,
  standing: StandingScreen | null,
  parsedHasGeography = false,
): boolean {
  if (!standing) return false
  if (parsedHasGeography) return false
  const lower = queryText.toLowerCase()
  const namesStanding = standing.geographies.some((g) => g.length > 0 && lower.includes(g.toLowerCase()))
  if (namesStanding) return false
  return FRAGMENT_SIGNALS.some((s) => lower.includes(s))
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
