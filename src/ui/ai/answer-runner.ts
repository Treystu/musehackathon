import { runAnswerPipeline, type ComposedAnswer } from '../../core/ai/answer'
import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import type { AreaRow } from '../../core/plugins/acs'
import {
  asStateCode,
  splitStateSuffix,
  type PlaceIndex,
} from '../../core/zcta-place-index'

/**
 * The UI-layer adapter between the Ask flow and the answer pipeline
 * (core/ai/answer.ts). The pipeline's seams are caller-supplied —
 * rows, geography resolution, the research provider — and this module
 * is where the app supplies them from the place index and the loaded
 * sweep. Core stays untouched; everything here reads seams core
 * already exposes.
 */

export interface ResolvedAnswerGeographies {
  /** ZCTAs the intent's geographies resolve to, for the pipeline's geographyZctas seam. */
  zctas: ReadonlySet<string>
  /** 2-character ZIP prefixes covering those ZCTAs — the sweep scope a load needs. */
  scopePrefixes: string[]
  /** The intent named geographies, but none of them resolved to a ZCTA. */
  unresolvable: boolean
}

/**
 * Resolve an intent's geographies to ZCTAs through the place index,
 * the same authority executeIntent resolves through.
 *
 * Lookup/compare keep executeIntent's own rule — one ZIP per named
 * place, a city record preferred over a county fallback — because the
 * plain figure card answers for the place the comparison opened. A
 * sweep resolves the whole geography (every ZIP in the named city or
 * state), because the screen's job is to narrow all of it by the
 * stated criteria. A 5-digit geography is its own ZCTA and needs no
 * index. Anything that resolves to nothing is reported through
 * `unresolvable`, never guessed.
 */
export function resolveAnswerGeographies(
  intent: ValidatedIntent,
  placeIndex: PlaceIndex | null,
): ResolvedAnswerGeographies {
  const zctas = new Set<string>()
  const singleZipPerPlace = intent.mode === 'lookup' || intent.mode === 'compare'
  for (const geography of intent.geographies) {
    const trimmed = geography.trim()
    if (/^\d{5}$/.test(trimmed)) {
      zctas.add(trimmed)
      continue
    }
    if (!placeIndex) continue
    if (!singleZipPerPlace) {
      const state =
        asStateCode(geography) ?? splitStateSuffix(trimmed.toLowerCase()).state
      if (state) {
        for (const place of placeIndex.places) {
          if (place.state === state) {
            for (const zip of place.zips) zctas.add(zip)
          }
        }
        continue
      }
    }
    const hits = placeIndex.search(geography, 8)
    const hit = hits.find((h) => h.isCity) ?? hits[0]
    if (!hit) continue
    if (singleZipPerPlace) {
      const first = hit.zips[0]
      if (first) zctas.add(first)
    } else {
      for (const zip of hit.zips) zctas.add(zip)
    }
  }
  const scopePrefixes = [...new Set([...zctas].map((z) => z.slice(0, 2)))].sort()
  return {
    zctas,
    scopePrefixes,
    unresolvable: intent.geographies.length > 0 && zctas.size === 0,
  }
}

/**
 * Whether the currently loaded sweep can serve as the screen's rows.
 * `sweepScope` is the scope the loaded rows were fetched under, in
 * the 2-character prefixes every applyScope caller passes; an empty
 * scope is a national load, which covers any geography. A placeless
 * question needs the national load specifically — a state-scoped
 * leftover must not silently stand in for the whole country (the
 * same widening rule executeIntent applies).
 */
export function answerScopeCovered(input: {
  rowCount: number
  sweepScope: readonly string[]
  resolved: ResolvedAnswerGeographies
  placeless: boolean
}): boolean {
  if (input.rowCount === 0) return false
  if (input.sweepScope.length === 0) return true
  if (input.placeless) return false
  return input.resolved.scopePrefixes.every((prefix) => input.sweepScope.includes(prefix))
}

/**
 * Run the pipeline for one Ask request over already-loaded rows.
 *
 * Returns null — no card — in exactly two cases: the intent named
 * geographies none of which resolved (executeIntent's run note
 * already discloses that, and a card screening the wrong set would
 * contradict it), and a 'blocked' answer, whose parse-gate refusal
 * the panel's own schema validation upstream already speaks for; the
 * views executeIntent ran remain the result. Research failures
 * propagate to the caller, which likewise falls back to no card.
 */
export async function composeAnswerForRequest(input: {
  intent: ValidatedIntent
  queryText: string
  rows: readonly AreaRow[]
  resolved: ResolvedAnswerGeographies
  provider: MuseProvider
  /** Whether this question carries criteria Census cannot serve (AskPanel's needsResearch). */
  research: boolean
  signal?: AbortSignal
}): Promise<ComposedAnswer | null> {
  if (input.resolved.unresolvable) return null
  const answer = await runAnswerPipeline({
    intent: input.intent,
    rows: input.rows,
    geographyZctas: input.resolved.zctas.size > 0 ? input.resolved.zctas : undefined,
    researchQuery: input.research ? input.queryText : undefined,
    provider: input.provider,
    signal: input.signal,
  })
  return answer.status === 'blocked' ? null : answer
}
