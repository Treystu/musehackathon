import {
  runAnswerPipeline,
  type ComposedAnswer,
  type ResolvedCandidate,
} from '../../core/ai/answer'
import { stateCodeForGeography } from '../../core/ai/national-screen'
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
        asStateCode(geography) ??
        splitStateSuffix(trimmed.toLowerCase()).state ??
        stateCodeForGeography(geography)
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
 * Research-first candidate resolution through the place index: an
 * extracted name resolves to every ZCTA of the place the index
 * matches for it (a city record preferred over a county fallback,
 * the same preference as geography resolution above). A name with
 * no index hit resolves to nothing — it is reported by the pipeline
 * in unresolvedCandidates, never guessed.
 */
export function resolveCandidatesWithIndex(
  names: readonly string[],
  placeIndex: PlaceIndex | null,
): ResolvedCandidate[] {
  if (!placeIndex) return []
  const resolved: ResolvedCandidate[] = []
  for (const name of names) {
    const hits = placeIndex.search(name, 8)
    const hit = hits.find((h) => h.isCity) ?? hits[0]
    if (hit) resolved.push({ name, zctas: [...hit.zips] })
  }
  return resolved
}

/**
 * Join each row's human display name from the place index, keyed by
 * the row's ZCTA: "Corbin, KY" in place of the name the row arrived
 * with.
 *
 * The join has to happen here, before the pipeline runs, because of
 * what production rows actually carry. The ACS builder names every
 * sweep row with the Census NAME label, which for a ZCTA is
 * literally "ZCTA5 40771" — so an unjoined row.name is a raw label,
 * not a place. The pipeline consumes row.name raw in three places a
 * reader or a source can see: the composed places the AnswerCard
 * headlines, the research stage's places list (screen-first research
 * was being told "ZCTA5 96720" instead of "Hilo, HI"), and claim
 * attribution, which matches researched claims to places by name
 * mention — sources write "Corbin, KY", never "ZCTA5 40771", so an
 * unjoined name also breaks attribution. The sweep table already
 * joins at render through App's placeLabel; the answer layer cannot
 * join at render, because by then the research stage has run.
 *
 * The format is the index's own label() — "City, ST" — the same
 * string App's placeLabel hands the sweep table, the comparison and
 * the CSV export, so a place is named identically on every surface.
 * A ZCTA the index has no entry for keeps its row's own name: the
 * fallback is the label the row arrived with, never a blank and
 * never a guess. Input rows are not mutated — the loaded sweep is
 * shared state other surfaces still read.
 */
export function withPlaceDisplayNames(
  rows: readonly AreaRow[],
  placeIndex: PlaceIndex | null | undefined,
): readonly AreaRow[] {
  if (!placeIndex) return rows
  return rows.map((row) => {
    const label = placeIndex.label(row.zcta)
    return label && label !== row.name ? { ...row, name: label } : row
  })
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
 * contradict it), and a 'blocked' answer. The blocked case's caller
 * (App's answer effect) renders the refusal as the answer area's
 * note in the card's blocked words — on the research-first handoff
 * path nothing upstream speaks for a blocked composition, and a
 * silent null there was one half of the Round 11 dead-end.
 * Research failures propagate to the caller, which likewise renders
 * them as the answer area's note and records the failure class in
 * diagnostics; no terminal state of this pipeline is silent.
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
  /**
   * Place index for research-first candidate resolution and for the
   * display-name join (withPlaceDisplayNames); absent = row-name
   * resolution only, and rows keep the names they arrived with.
   */
  placeIndex?: PlaceIndex | null
}): Promise<ComposedAnswer | null> {
  if (input.resolved.unresolvable) return null
  // Both directions read the same joined rows: screen-first hands
  // them to the screen and the research stage, research-first pulls
  // its candidates from them — one join at the entry covers both.
  const rows = withPlaceDisplayNames(input.rows, input.placeIndex)
  const answer = await runAnswerPipeline({
    intent: input.intent,
    rows,
    geographyZctas: input.resolved.zctas.size > 0 ? input.resolved.zctas : undefined,
    researchQuery: input.research ? input.queryText : undefined,
    queryText: input.queryText,
    provider: input.provider,
    signal: input.signal,
    candidateResolver: input.placeIndex
      ? (names) => resolveCandidatesWithIndex(names, input.placeIndex ?? null)
      : undefined,
  })
  return answer.status === 'blocked' ? null : answer
}
