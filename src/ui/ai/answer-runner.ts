import {
  breadthShapeFor,
  decomposeResearchCriteria,
  NO_PLACE_LOOKUP_DETAIL,
  requestsStateLevel,
  runAnswerPipeline,
  screenCriteriaFromIntent,
  type ComposedAnswer,
  type ResolvedCandidate,
} from '../../core/ai/answer'
import {
  buildPlanPacket,
  buildVerifyPacket,
  createHttpBookendTransports,
  wonderLabelFor,
  type PlanTransport,
  type VerifyTransport,
} from '../../core/ai/bookends'
import {
  branchDefinition,
  decisionEffect,
  phraseBranchQuestion,
  readSessionDecisions,
  refinementNote,
  rephraseBranchQuestion,
  subjectForCriterion,
  writeSessionDecision,
  type BranchId,
  type DecisionsRecord,
} from '../../core/ai/decision-branches'
import {
  JEV_BRANCH_THRESHOLD,
  JEV_PHRASE_THRESHOLD,
  PHRASE_QUESTION_ID,
  BRANCH_CHOICE_QUESTION_ID,
  BRANCH_QUESTION_ID,
  choiceSelection,
  createHttpJevTransport,
  noulProbability,
  type JevTransport,
} from '../../core/ai/jev-judgments'
import { runJevLoop } from '../../core/ai/jev-loop'
import {
  blendEvidenceText,
  decidedEvidenceText,
  isProximityCriterion,
  proximityFocus,
} from '../../core/ai/nearby'
import {
  buildNearFrameContext,
  detectNearFrame,
  type NearFrameContext,
} from '../../core/ai/near-frame'
import {
  buildGeographyGateContext,
  classifyStatesFromResearch,
  detectGeographyGate,
  gateBoundZctas,
  gateClassificationQueryText,
  stateCountPhrase,
  type GeographyGateContext,
  type GeographyGateSpec,
} from '../../core/ai/geography-gate'
import type { ZctaPoint } from '../../core/map/centroids'
import {
  createHttpFlexibleTransport,
  type FlexibleTransport,
} from '../../core/ai/flexible'
import { RESEARCH_QUERY_MAX_CHARS } from '../../core/ai/meta-client'
import { composeFlexibleCompletion } from './flexible-runner'
import {
  stateCodeForGeography,
} from '../../core/ai/national-screen'
import type { StateAggregateGeography } from '../../core/ai/answer'
import type { RunProgressSnapshot } from '../../core/ai/run-progress'
import { buildStatePartitions, STATE_NAME_BY_CODE } from '../../core/sweep/states'
import type { CountyIndex, CountyGroup } from '../../core/zcta-county-index'
import type { MuseProvider, ValidatedIntent } from '../../core/ai/provider'
import type { StageId } from './session-store'
import type { AreaRow } from '../../core/plugins/acs'
import {
  splitStateSuffix,
  type PlaceIndex,
  type PlaceSuggestion,
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
  /**
   * The geographies that resolved to nothing, named individually —
   * a comparison whose other side resolved still carries its failed
   * side here, so the card names it as unresolved instead of the
   * comparison silently going one-sided (battery C4: Denver County
   * dropped without a word). `unresolvable` above stays the
   * all-failed flag the callers' early paths use.
   */
  unresolvedGeographies: string[]
  /**
   * Readings of a geography that are not its literal name — a region
   * read as the Census region of that name, a region not served at
   * region level, a multi-ZIP place served by one representative
   * ZIP in lookup/compare — worded for the card, so the reading is
   * disclosed where the answer is shown, from this same result.
   */
  geographyDisclosures: string[]
  /**
   * States named as lookup/compare geographies, with the member
   * ZCTAs the pipeline aggregates into one state-average place.
   * Empty for sweeps: a state in a sweep is a scope, not an average.
   */
  stateAggregates: StateAggregateGeography[]
  /** Counties named as geographies, expanded through the county index when one was supplied. */
  countyGeographies: { geography: string; censusName: string; state: string; zctas: string[] }[]
}

/**
 * Census regions and divisions, by the Census Bureau's own state
 * lists — the only region definitions this tool serves. A region
 * name resolves to the screen over exactly these states, disclosed
 * on the card; it never falls through to place search, where
 * "Midwest" is also a town in Wyoming (battery B6: that town was
 * presented as the region's answer, honesty 0.06).
 */
const REGION_STATES: Readonly<Record<string, readonly string[]>> = {
  midwest: ['IL', 'IN', 'MI', 'OH', 'WI', 'IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  northeast: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'],
  south: ['DE', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'DC', 'WV', 'AL', 'KY', 'MS', 'TN', 'AR', 'LA', 'OK', 'TX'],
  west: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY', 'AK', 'CA', 'HI', 'OR', 'WA'],
  'new england': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
  'mid-atlantic': ['NJ', 'NY', 'PA'],
  'middle atlantic': ['NJ', 'NY', 'PA'],
  'south atlantic': ['DE', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'DC', 'WV'],
  'east south central': ['AL', 'KY', 'MS', 'TN'],
  'west south central': ['AR', 'LA', 'OK', 'TX'],
  'east north central': ['IL', 'IN', 'MI', 'OH', 'WI'],
  'west north central': ['IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  mountain: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'],
  'mountain west': ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'],
  pacific: ['AK', 'CA', 'HI', 'OR', 'WA'],
}

/**
 * Region-shaped names with no Census definition this tool can serve
 * at region level. They are disclosed as not served at that
 * granularity rather than matched to a same-named place.
 */
const UNSERVED_REGIONS: ReadonlySet<string> = new Set([
  'pacific northwest',
  'southwest',
  'southeast',
  'northwest',
  'great plains',
  'great lakes',
  'deep south',
  'sun belt',
  'rust belt',
  'appalachia',
  'new south',
  'mid-south',
])

function normaliseGeographyName(text: string): string {
  return text.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ')
}

/** The state a geography names outright — code, full name, or a "state average" form — or null. */
function bareStateCode(text: string): string | null {
  const trimmed = text.trim()
  const direct = stateCodeForGeography(trimmed)
  if (direct) return direct
  const average = /^(.+?)(?:\s+state)?\s+average$/i.exec(trimmed)
  if (average) return stateCodeForGeography(average[1]!)
  return null
}

/**
 * Splits "Name, <state>" where the state may be a code or a full
 * name ("Boulder County, Colorado" is the intent route's county
 * form; splitStateSuffix alone splits codes only).
 */
function splitStateDesignator(text: string): { name: string; state: string | null } {
  const trimmed = text.trim()
  const comma = trimmed.lastIndexOf(',')
  if (comma > 0) {
    const state = stateCodeForGeography(trimmed.slice(comma + 1))
    if (state) return { name: trimmed.slice(0, comma).trim(), state }
  }
  const suffixed = splitStateSuffix(trimmed.toLowerCase())
  return { name: suffixed.name, state: suffixed.state }
}

/** Whether a name carries a county-class legal suffix (county, parish, borough, census area, municipality). */
const COUNTY_LIKE_RE = /\b(county|parish|borough|census area|municipality)\b/i

/**
 * Match a geography against the county index: the name part must
 * EQUAL a county's Census name — a prefix or substring match is how
 * a city search ends up standing a fallback ZIP in for a county.
 * State designators in the geography itself win; a single sibling
 * state's designator in the same intent disambiguates a county name
 * several states share; anything still ambiguous resolves to
 * nothing rather than to a guessed state.
 */
export function matchCountyGeography(
  geography: string,
  countyIndex: CountyIndex,
  siblingStates: readonly string[] = [],
): CountyGroup | null {
  const { name, state } = splitStateDesignator(geography)
  const wanted = name.toLowerCase()
  let matches = countyIndex.counties.filter((c) => c.censusName.toLowerCase() === wanted)
  if (matches.length === 0) return null
  if (state) matches = matches.filter((c) => c.state === state)
  else if (matches.length > 1 && siblingStates.length === 1) {
    matches = matches.filter((c) => c.state === siblingStates[0])
  }
  return matches.length === 1 ? matches[0]! : null
}

/** The states an intent's geographies designate outright, for county disambiguation. */
function siblingStateCodes(intent: ValidatedIntent): string[] {
  const states: string[] = []
  for (const geography of intent.geographies) {
    const state = bareStateCode(geography) ?? splitStateDesignator(geography).state
    if (state && !states.includes(state)) states.push(state)
  }
  return states
}

/**
 * Resolve an intent's geographies to ZCTAs through the place index,
 * the same authority executeIntent resolves through.
 *
 * Resolution order is the geography's own specificity, most specific
 * first — measured against the battery failures each step prevents:
 *
 *   1. A 5-digit geography is its own ZCTA and needs no index.
 *   2. A geography naming a county expands through the county index
 *      to ALL of the county's member ZCTAs, in every mode (battery
 *      C3/C4: resolution through the place index returned the single
 *      county-fallback ZIP, whose figures were then aggregated
 *      alone under the county name). Without a county index a
 *      county-named geography is reported unresolved — never
 *      approximated from the place fallback; composeAnswerForRequest
 *      re-expands it when the caller hands the runner a county
 *      index the resolver did not have.
 *   3. A region name resolves to the Census region's states and is
 *      disclosed as that reading; a region with no Census definition
 *      here is disclosed as not served at that granularity. Neither
 *      ever reaches place search (battery B6).
 *   4. A bare state name widens to the state — the only widening.
 *      In lookup/compare the state is ALSO recorded as a state
 *      aggregate, and the pipeline composes it as one state-average
 *      place (battery C6); in a sweep it is the screen's scope.
 *   5. "City, ST" resolves the CITY: the state suffix only scopes
 *      the city search (battery D2: the previous order tried the
 *      state suffix first, so "Portland, OR" in a sweep widened to
 *      the whole state and Eugene and Salem answered for Portland).
 *   6. A bare place name resolves through place search: one ZIP per
 *      named place for lookup/compare (executeIntent's own rule, a
 *      city record preferred over a county fallback), every ZIP of
 *      the place for a sweep.
 *
 * Steps 5/6 in lookup/compare serve ONE ZIP for a place that may
 * span many: that ZIP stands in for the whole named place, and the
 * shortfall is recorded in geographyDisclosures at the moment it is
 * taken (battery D1, granularity_shortfall_unstated: "Seattle"
 * answered by 98101 alone, with nothing on the card stating that
 * one ZIP area was standing in for the city).
 *
 * Anything that resolves to nothing is named in
 * `unresolvedGeographies`, never guessed; `unresolvable` reports
 * the all-failed case the early paths key on.
 */
export function resolveAnswerGeographies(
  intent: ValidatedIntent,
  placeIndex: PlaceIndex | null,
  countyIndex?: CountyIndex | null,
): ResolvedAnswerGeographies {
  const zctas = new Set<string>()
  const unresolvedGeographies: string[] = []
  const geographyDisclosures: string[] = []
  const stateAggregates: StateAggregateGeography[] = []
  const countyGeographies: ResolvedAnswerGeographies['countyGeographies'] = []
  const singleZipPerPlace = intent.mode === 'lookup' || intent.mode === 'compare'
  const siblings = siblingStateCodes(intent)

  // Take a place-search hit's ZIPs under the mode's rule. In
  // lookup/compare that is one representative ZIP; when the place
  // spans more than one ZIP area, the served ZIP is standing in for
  // the whole place, so the granularity shortfall is recorded as a
  // disclosure from this same resolution result (battery D1) — the
  // count is the place index's own ZIP list for the place, and the
  // line names the ZIP that will actually be served. A sweep takes
  // every ZIP of the place, so no shortfall arises and none is
  // recorded; a single-ZIP place has no shortfall to state.
  const addPlaceHit = (geographyLabel: string, hit: PlaceSuggestion) => {
    if (!singleZipPerPlace) {
      for (const zip of hit.zips) zctas.add(zip)
      return
    }
    const first = hit.zips[0]
    if (!first) return
    zctas.add(first)
    if (hit.zips.length > 1) {
      const line =
        `${geographyLabel} spans ${hit.zips.length} ZIP areas; the answer shows the one ` +
        `resolved ZIP area for it (${first}), not the whole ${hit.isCity ? 'city' : 'place'}.`
      if (!geographyDisclosures.includes(line)) geographyDisclosures.push(line)
    }
  }

  // Every ZCTA in the state, whether or not an earlier geography
  // already added some of them: a state aggregate's member list must
  // be complete even when one of its ZIPs was also named outright.
  const addStateZctas = (state: string): string[] => {
    const all: string[] = []
    if (!placeIndex) return all
    for (const place of placeIndex.places) {
      if (place.state !== state) continue
      for (const zip of place.zips) {
        all.push(zip)
        zctas.add(zip)
      }
    }
    return all
  }

  for (const geography of intent.geographies) {
    const trimmed = geography.trim()
    if (/^\d{5}$/.test(trimmed)) {
      zctas.add(trimmed)
      continue
    }

    // 2. Named county — before place search, whose county-fallback
    // record is the stand-in this step exists to replace.
    const { name: namePart } = splitStateDesignator(trimmed)
    if (COUNTY_LIKE_RE.test(namePart)) {
      const group = countyIndex ? matchCountyGeography(trimmed, countyIndex, siblings) : null
      if (group) {
        for (const zip of group.zips) zctas.add(zip)
        countyGeographies.push({
          geography: trimmed,
          censusName: group.censusName,
          state: group.state,
          zctas: [...group.zips],
        })
      } else {
        unresolvedGeographies.push(trimmed)
      }
      continue
    }

    // 3. Region names.
    const normalised = normaliseGeographyName(trimmed)
    const regionStates = REGION_STATES[normalised]
    if (regionStates) {
      const added = placeIndex ? regionStates.flatMap((s) => addStateZctas(s)) : []
      if (added.length === 0) unresolvedGeographies.push(trimmed)
      const stateNames = regionStates
        .map((code) => STATE_NAME_BY_CODE[code] ?? code)
        .join(', ')
      geographyDisclosures.push(
        `${trimmed} was read as the Census region of that name — ${stateNames} — ` +
          'and the results cover that region.',
      )
      continue
    }
    if (UNSERVED_REGIONS.has(normalised)) {
      unresolvedGeographies.push(trimmed)
      geographyDisclosures.push(
        `${trimmed} names a region this tool does not serve at region level, ` +
          'so it was not matched to a place with the same name.',
      )
      continue
    }

    // 4. Bare state.
    const state = bareStateCode(trimmed)
    if (state) {
      const added = addStateZctas(state)
      if (!placeIndex) {
        unresolvedGeographies.push(trimmed)
        continue
      }
      if (singleZipPerPlace) {
        stateAggregates.push({
          geography: trimmed,
          label: STATE_NAME_BY_CODE[state] ?? trimmed,
          state,
          zctas: added,
        })
      }
      continue
    }

    if (!placeIndex) {
      unresolvedGeographies.push(trimmed)
      continue
    }

    // 5. "City, ST" — the suffix scopes the city search; it never
    // widens to the state.
    const designator = splitStateDesignator(trimmed)
    if (designator.state) {
      const hits = placeIndex.search(`${designator.name}, ${designator.state}`, 8)
      const hit = hits.find((h) => h.isCity) ?? hits[0]
      if (!hit) {
        unresolvedGeographies.push(trimmed)
        continue
      }
      addPlaceHit(trimmed, hit)
      continue
    }

    // 6. Bare place name.
    const hits = placeIndex.search(geography, 8)
    const hit = hits.find((h) => h.isCity) ?? hits[0]
    if (!hit) {
      unresolvedGeographies.push(trimmed)
      continue
    }
    addPlaceHit(trimmed, hit)
  }
  const scopePrefixes = [...new Set([...zctas].map((z) => z.slice(0, 2)))].sort()
  return {
    zctas,
    scopePrefixes,
    unresolvable: intent.geographies.length > 0 && zctas.size === 0,
    unresolvedGeographies,
    geographyDisclosures,
    stateAggregates,
    countyGeographies,
  }
}

/**
 * Re-expand county-named geographies against a county index the
 * resolver did not have (the App path: the answer effect resolves
 * with the place index alone, while composeAnswerForRequest holds
 * the county index). Returns the resolution with county members
 * merged in and the counties they cover removed from the unresolved
 * list — the same resolution result, completed, so every surface
 * downstream reads one result.
 */
export function expandCountyGeographies(
  resolved: ResolvedAnswerGeographies,
  intent: ValidatedIntent,
  countyIndex: CountyIndex,
): ResolvedAnswerGeographies {
  const siblings = siblingStateCodes(intent)
  const zctas = new Set(resolved.zctas)
  const countyGeographies = [...resolved.countyGeographies]
  const stillUnresolved: string[] = []
  for (const geography of resolved.unresolvedGeographies) {
    const { name: namePart } = splitStateDesignator(geography)
    const group = COUNTY_LIKE_RE.test(namePart)
      ? matchCountyGeography(geography, countyIndex, siblings)
      : null
    if (!group) {
      stillUnresolved.push(geography)
      continue
    }
    for (const zip of group.zips) zctas.add(zip)
    if (!countyGeographies.some((c) => c.geography === geography)) {
      countyGeographies.push({
        geography,
        censusName: group.censusName,
        state: group.state,
        zctas: [...group.zips],
      })
    }
  }
  if (countyGeographies.length === resolved.countyGeographies.length) return resolved
  const scopePrefixes = [...new Set([...zctas].map((z) => z.slice(0, 2)))].sort()
  return {
    ...resolved,
    zctas,
    scopePrefixes,
    unresolvable: intent.geographies.length > 0 && zctas.size === 0,
    unresolvedGeographies: stillUnresolved,
    countyGeographies,
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

/* ------------------------------------------------------------------ */
/* Conversational stack (plan C2/C4/C5/C7/C8/C9)                       */
/* ------------------------------------------------------------------ */

/**
 * The conversational stack's injectable transports. Tests script
 * them; production defaults are the HTTP transports against the
 * sibling lane's routes (/api/muse/jev, /api/muse/plan,
 * /api/muse/verify). Every transport failure degrades its own
 * consumer only: the loop is skipped, no modal interjects, the
 * bookend labels not-run — the answer always ships on the
 * deterministic pipeline alone.
 */
export interface ConversationalStackDeps {
  jevTransport?: JevTransport
  planTransport?: PlanTransport
  verifyTransport?: VerifyTransport
  /** The flexible completion lane's draft transport; defaults to the HTTP route transport. */
  flexibleTransport?: FlexibleTransport
  /** Landed decisions for this run; defaults to the session record. */
  decisions?: DecisionsRecord
  /** Branches already closed this session (never re-proposed). */
  closedBranches?: ReadonlySet<string>
}

function defaultStack(deps: ConversationalStackDeps | undefined): Required<
  Pick<ConversationalStackDeps, 'jevTransport' | 'planTransport' | 'verifyTransport' | 'flexibleTransport'>
> & { decisions: DecisionsRecord; closedBranches: ReadonlySet<string> } {
  const bookends = createHttpBookendTransports()
  return {
    jevTransport: deps?.jevTransport ?? createHttpJevTransport(),
    planTransport: deps?.planTransport ?? bookends.plan,
    verifyTransport: deps?.verifyTransport ?? bookends.verify,
    flexibleTransport: deps?.flexibleTransport ?? createHttpFlexibleTransport(),
    decisions: deps?.decisions ?? readSessionDecisions(),
    closedBranches: deps?.closedBranches ?? new Set(),
  }
}

/**
 * Whether criterion decomposition reaches the pipeline for this
 * question (P3b cure 2, battery C5). Shipped, the runner passed
 * decomposition only when AskPanel's lexical needsResearch regex
 * fired, and that regex has no internet/broadband arm — so P3's
 * internet decomposition existed in the pipeline and in its unit
 * test (which calls the pipeline directly) but was unreachable at
 * the App seam, and the criterion never appeared on the card.
 * Decision: the gate fires decomposition from the PARSED CRITERIA —
 * any named catalog criterion in the reader's words (an entry of
 * decomposeResearchCriteria other than the combined carry) reaches
 * the pipeline whether or not the lexical trigger fired.
 * needsResearch keeps its own job unchanged: it decides the
 * research CALL (researchQuery / provider passes), so a decomposed
 * Census criterion (internet, cost of living, salary) is assessed
 * from figures with no web pass, and a research-class criterion the
 * trigger missed is at least ACCOUNTED on the card (labelled not
 * measurable when no research served it) instead of vanishing.
 * The correspondence pin (tests/ai/p3b-seams.test.ts) enumerates
 * the decomposition catalog and asserts every entry reaches the
 * pipeline through this gate, so a future catalog entry cannot
 * ship unreachable the way internet did.
 */
export function decompositionReachesPipeline(queryText: string, research: boolean): boolean {
  return (
    research || decomposeResearchCriteria(queryText).some((criterion) => criterion.id !== 'combined')
  )
}

/**
 * Compose one research pass's queryText within the research
 * route's ceiling (RESEARCH_QUERY_MAX_CHARS — the shared constant
 * the route validates against). Prioritization is explicit and
 * fixed: the reader's question rides first and verbatim; steering
 * additions (decision focus texts, the Jev loop's gap
 * instructions) fill the remaining budget in the caller's order.
 * An addition that fits whole rides whole; one that does not is
 * trimmed at a word boundary into the remaining budget when at
 * least MIN_RESEARCH_ADDITION_CHARS of it can ride (a shorter
 * fragment is noise, so the addition is skipped instead). Either
 * way the returned `trimmed` flag is set, and the caller discloses
 * the shortening on the researched criteria's evidence lines —
 * the question and the criteria are never the trimmed material:
 * criteria travel in their own array, places in theirs, and the
 * question is trimmed only in the defensive case where it alone
 * exceeds the ceiling (the intent stage caps questions at the
 * same 500, so that case is unreachable in the app flow).
 * Measured 2026-11-03: without composition, question + proximity
 * focus (370) was compliant but one patch round reached 572 and
 * every iterative pass was refused by the route.
 */
export const MIN_RESEARCH_ADDITION_CHARS = 40

export function composeResearchQueryText(
  question: string,
  additions: readonly string[],
): { text: string; trimmed: boolean } {
  let text = question
  let trimmed = false
  if (text.length > RESEARCH_QUERY_MAX_CHARS) {
    const cut = text.slice(0, RESEARCH_QUERY_MAX_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    text = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()
    trimmed = true
  }
  for (const addition of additions) {
    if (!addition) continue
    const remaining = RESEARCH_QUERY_MAX_CHARS - text.length - 1
    if (remaining < MIN_RESEARCH_ADDITION_CHARS) {
      trimmed = true
      continue
    }
    if (addition.length <= remaining) {
      text = `${text} ${addition}`
      continue
    }
    const cut = addition.slice(0, remaining)
    const lastSpace = cut.lastIndexOf(' ')
    text = `${text} ${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}`
    trimmed = true
  }
  return { text, trimmed }
}

/** The loop's criterion list: Census measures first, then researched criteria. */
function loopCriteriaFor(
  intent: ValidatedIntent,
  research: boolean,
  queryText: string,
): { id: string; text: string }[] {
  const criteria: { id: string; text: string }[] = []
  for (const criterion of screenCriteriaFromIntent(intent).criteria) {
    criteria.push({ id: criterion.metricKey, text: criterion.metricKey })
  }
  for (const key of intent.metricKeys) {
    if (!criteria.some((c) => c.id === key)) criteria.push({ id: key, text: key })
  }
  if (research) {
    for (const criterion of decomposeResearchCriteria(queryText)) {
      criteria.push({ id: criterion.id, text: criterion.label })
    }
  }
  return criteria
}

/** Serialize an answer for Jev evaluation and for the patch request. */
function answerTextForLoop(answer: ComposedAnswer): string {
  const evidence = answer.criterionEvidence
    .map((entry) => `${entry.criterion}: ${entry.status} — ${entry.detail}`)
    .join('\n')
  const claims = [...answer.places.flatMap((p) => p.claims), ...answer.generalClaims]
    .map((claim) => claim.text)
    .join('\n')
  return [answer.summary, evidence, claims].filter((part) => part !== '').join('\n')
}

/**
 * The branch evaluation at the screen -> research boundary (plan
 * C7): J-BRANCH over the stage state, then the C8 specificity rule —
 * phrase from the live ask, J-PHRASE check, ONE rephrase attempt,
 * then interjection closes for that question. Returns the proposal
 * the surface renders, or null. Any transport failure = no
 * interjection (the provisional interpretation proceeds).
 */
export async function evaluateDecisionProposal(input: {
  queryText: string
  intent: ValidatedIntent
  research: boolean
  decisions: DecisionsRecord
  closedBranches: ReadonlySet<string>
  jevTransport: JevTransport
}): Promise<ComposedAnswer['decisionProposal']> {
  const criteria = loopCriteriaFor(input.intent, input.research, input.queryText)
  if (criteria.length === 0) return undefined
  let branchReply
  try {
    branchReply = await input.jevTransport({
      set: 'J-BRANCH',
      state: {
        question: input.queryText,
        criteria: criteria.map((c) => c.text),
        provisionalInterpretation: 'comprehensive',
      },
    })
  } catch {
    return undefined
  }
  const fire = noulProbability(branchReply.answers, BRANCH_QUESTION_ID)
  if (fire === null || fire < JEV_BRANCH_THRESHOLD) return undefined
  const branchId = choiceSelection(branchReply.answers, BRANCH_CHOICE_QUESTION_ID)
  const definition = branchId ? branchDefinition(branchId) : null
  if (!definition) return undefined
  if (input.decisions[definition.id] !== undefined) return undefined
  if (input.closedBranches.has(definition.id)) return undefined
  const criterion = criteria.find((c) => definition.criterionIds.includes(c.id))
  if (!criterion) return undefined

  const subject = subjectForCriterion(criterion.id, input.queryText)
  const phraseState = (drafted: string) => ({
    draftedQuestion: drafted,
    question: input.queryText,
    criterion: criterion.text,
  })
  let drafted = phraseBranchQuestion(definition.id, input.queryText, criterion.text, subject)
  try {
    let score = noulProbability(
      (await input.jevTransport({ set: 'J-PHRASE', state: phraseState(drafted) })).answers,
      PHRASE_QUESTION_ID,
    )
    if (score === null || score < JEV_PHRASE_THRESHOLD) {
      drafted = rephraseBranchQuestion(definition.id, criterion.text, subject)
      score = noulProbability(
        (await input.jevTransport({ set: 'J-PHRASE', state: phraseState(drafted) })).answers,
        PHRASE_QUESTION_ID,
      )
      if (score === null || score < JEV_PHRASE_THRESHOLD) return undefined
    }
  } catch {
    return undefined
  }
  return {
    branch: definition.id,
    criterionId: criterion.id,
    questionText: drafted,
    options: definition.options.map((option) => ({ ...option })),
    dismissLabel: definition.dismissLabel,
  }
}

/**
 * A bookend transport call, settled: a transport that throws
 * degrades exactly like one that returns null — the bookend
 * abstains and the run proceeds on the deterministic stages. The
 * production HTTP transports already settle their own failures to
 * null; this holds the stack contract (every transport failure
 * degrades its own consumer only) for any transport a caller
 * injects, so one bookend failure can never block a run outright
 * or discard a composed answer (compose-degradation cure,
 * 2026-11-03: measured pre-cure, a throwing verify transport
 * rejected the run after a verified answer already existed).
 * Packet construction stays outside the settle: a defect in the
 * packet builders is a code error, not a transport failure, and
 * still surfaces as one.
 */
async function settleBookend<T>(call: () => Promise<T | null>): Promise<T | null> {
  try {
    return await call()
  } catch {
    return null
  }
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
 * A research failure degrades inside the pipeline on both paths
 * and never reaches the caller as a throw (answer.ts,
 * total-failure ladder, 2026-11-03): the screen path and the
 * state-bounded research-first arm land on the Census card with
 * the researched criteria recorded as lookup failures, and the
 * remaining research-first arms land on the honest-note answer.
 * Bookend transport failures settle the same way at this seam
 * (settleBookend above). What still propagates is a defect-class
 * throw — deterministic code failing, not a provider — which the
 * caller renders as the answer area's note and records in
 * diagnostics. No terminal state of this pipeline is silent.
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
  /**
   * ZIP-area centroids (the baked map geography), for the near
   * frame: a question naming one place as anchor and reference
   * ("where near Philadelphia ..., within 20 miles") draws its
   * candidate set from the places around the anchor, which needs
   * the centroid distances. Absent = the frame cannot engage and
   * the shipped path stands; the App loads the centroids for a
   * prechecked question (detectNearFrame) before composing.
   */
  centroids?: readonly ZctaPoint[] | null
  /**
   * County index for county-level answers: the pipeline's
   * countyAssignments seam is built from it over the request's
   * rows. Absent (the artefact failed to load), a county request
   * keeps the pipeline's unsupported reporting — never a rollup
   * approximated from place fallbacks.
   */
  countyIndex?: CountyIndex | null
  /**
   * Conversational-stack transports + decision state (plan
   * C2/C4/C5/C7). Absent = the production HTTP transports and the
   * session's landed decisions; `false` disables the stack for this
   * run (the deterministic pipeline alone, exactly as before it).
   */
  stack?: ConversationalStackDeps | false
  /**
   * Staged-status observer (drive item 17): forwarded at each real
   * stage boundary — the pipeline's own stages arrive through its
   * onStage seam (screen/research/compose/verify, renamed to the
   * reader-facing ids), and this runner adds the stages it owns:
   * 'wonder-plan' only when the top bookend transport is actually
   * called, 'jev' only when the Jev loop is actually invoked,
   * 'wonder-verify' only when the bottom bookend transport is
   * actually called. Observation-only, like the pipeline's seam.
   */
  onStage?: (stage: StageId, subject?: string | null) => void
  /**
   * Run-progress observer (Lane A7): forwarded to the pipeline's
   * onProgress seam on the FIRST pipeline run only. The Jev loop's
   * patch re-run is a revision of the same run, not a new gathering —
   * its passes do not re-emit, so the reader's progress record is
   * the initial research's, never a restarted fraction.
   */
  onProgress?: (snapshot: RunProgressSnapshot) => void
  /**
   * Preliminary-first staging (Phase 5, 2026-11-03; decisions
   * recorded in RESEARCHED-CLASS-PERF.md): for a researched
   * question with a resolved ZIP set (breadth runs excluded —
   * their roster is research-born), the caller receives the
   * deterministic screen composition — figures screened,
   * researched criteria carried as 'pending' evidence — as soon
   * as it exists, before
   * the branch evaluation, both bookends, and the research stage
   * run. The completed composition still returns from this
   * function's promise as before; the preliminary is a stage of
   * the run, never its terminal. Observation-only, like onStage:
   * it changes nothing the run computes.
   */
  onPreliminary?: (answer: ComposedAnswer) => void
}): Promise<ComposedAnswer | null> {
  // Complete the resolution with the county crosswalk before the
  // unresolvable gate: the caller resolved with the place index
  // alone (its county-named geographies are honestly unresolved
  // there), and this runner holds the county index — a named county
  // must expand here or the gate below would strand exactly the
  // questions the county cure serves.
  const countyCompleted = input.countyIndex
    ? expandCountyGeographies(input.resolved, input.intent, input.countyIndex)
    : input.resolved
  // The state-unit shape (cure round 3, 2026-11-03): the question
  // names the STATE as its subject and no geography at all ("which
  // state has the oldest population?"), so the caller's resolution
  // carries no state aggregates — it builds them only for named
  // state geographies, and a sweep names none. Supply every state's
  // aggregate from the place index's own partition of the loaded
  // rows: buildStatePartitions covers every enumerated ZCTA (a gap
  // falls back to its prefix's majority state within the same
  // pass), so the pipeline's state stage forms one aggregate per
  // state and the ranking runs over state figures — never the
  // silent downgrade to a national ZIP screen the live probe
  // recorded (33,791 ZIP places, youngest first, for the
  // oldest-population question).
  let stateAggregates = countyCompleted.stateAggregates
  if (
    input.placeIndex &&
    input.intent.geographies.length === 0 &&
    requestsStateLevel(input.queryText, input.intent)
  ) {
    const stateByZip = new Map<string, string>()
    for (const [zip, record] of input.placeIndex.byZip) stateByZip.set(zip, record.state)
    const partitions = buildStatePartitions(
      input.rows.map((row) => row.zcta),
      stateByZip,
    )
    stateAggregates = [
      ...partitions.map((partition) => ({
        geography: partition.label,
        label: partition.label,
        state: partition.code,
        zctas: partition.zctas,
      })),
      ...stateAggregates,
    ]
  }
  const resolved =
    stateAggregates === countyCompleted.stateAggregates
      ? countyCompleted
      : { ...countyCompleted, stateAggregates }
  if (resolved.unresolvable) return null
  const timings: Record<string, number> = {}
  const stack = input.stack === false ? null : defaultStack(input.stack ?? undefined)
  const decisions: DecisionsRecord = stack?.decisions ?? {}
  // Both directions read the same joined rows: screen-first hands
  // them to the screen and the research stage, research-first pulls
  // its candidates from them — one join at the entry covers both.
  const rows = withPlaceDisplayNames(input.rows, input.placeIndex)

  // The research query for this run: the reader's question, plus the
  // applicable focus where a decision or the nearby blend shapes it
  // (plan C9: a proximity criterion's research request carries the
  // applicable mode set; a landed non-transport decision carries its
  // own focus). Screen-first questions with no such criterion keep
  // the question text verbatim — the research contract the runner
  // tests pin.
  const researchCriteria = input.research ? decomposeResearchCriteria(input.queryText) : []
  let researchQuery = input.queryText

  // Near frame (core/ai/near-frame.ts): the question names one
  // place as its anchor and reference. The frame engages only
  // with the place index AND the centroid geography in hand;
  // without either, the shipped path stands unchanged. When it
  // engages, the resolution handed to the pipeline is the
  // frame's: the candidate set (places within the radius, the
  // anchor excluded) replaces the anchor's single resolved ZIP
  // as the screen bound, the anchor's single-ZIP granularity
  // disclosure is retired (the baseline is formed from ALL of
  // the anchor's ZIP areas, so the shortfall it stated no
  // longer exists) in favour of the reference disclosure, and
  // the frame context rides into the pipeline for its screen
  // bound, evidence rules, and claim discipline.
  let nearFrame: NearFrameContext | null = null
  if (input.placeIndex && input.centroids && input.centroids.length > 0) {
    const spec = detectNearFrame(input.queryText, input.intent)
    if (spec) {
      const costCriterion = researchCriteria.find((c) => c.id === 'cost_of_living')
      const baselineKey = costCriterion?.decomposedMetricKey ?? 'median_gross_rent'
      const decomposedKeys = researchCriteria
        .map((c) => c.decomposedMetricKey)
        .filter((k): k is string => !!k)
      nearFrame = buildNearFrameContext({
        spec,
        placeIndex: input.placeIndex,
        centroids: input.centroids,
        rows,
        figureKeys: [...new Set([...input.intent.metricKeys, ...decomposedKeys, baselineKey])],
        baselineKey,
        costReading: !!costCriterion || input.intent.metricKeys.includes(baselineKey),
      })
    }
  }
  const frameResolved: ResolvedAnswerGeographies = nearFrame
    ? {
        ...resolved,
        zctas: nearFrame.candidateZctas,
        scopePrefixes: nearFrame.candidatePrefixes,
        geographyDisclosures: [
          `${nearFrame.anchorLabel} is the comparison reference for this question: the places shown are the places within ${nearFrame.radiusMiles} miles of it, and its own baseline figures are formed from all ${nearFrame.anchorZipCount} of its ZIP areas.`,
          ...resolved.geographyDisclosures.filter(
            (line) => !line.startsWith(`${input.intent.geographies[0]!.trim()} spans `),
          ),
        ],
      }
    : resolved
  // Geography gate (core/ai/geography-gate.ts): the question's
  // first criterion is a researched classification of STATES and
  // its second part seeks a Census extremum inside the state(s)
  // the classification returns ("what state has the most relaxed
  // drug laws — and the lowest cost of living in that state?").
  // The classification resolves FIRST — one research pass, before
  // any pipeline run — and the screen then runs bounded to the
  // qualifying states through the same resolution seam the near
  // frame uses. Detection is structural (the module's contract);
  // an empty classification, a failed research call, or a bound
  // with no rows in the loaded set leaves the shipped path
  // standing, exactly as the near frame behaves when it cannot
  // form. The near frame and the gate never co-engage (the frame
  // needs a named anchor geography; the gate needs none named).
  let geographyGate: GeographyGateContext | null = null
  let gateBound: ReadonlySet<string> | null = null
  let gateSpec: GeographyGateSpec | null = null
  if (input.research && !nearFrame) {
    gateSpec = detectGeographyGate({
      queryText: input.queryText,
      intent: input.intent,
      researchCriteria,
    })
    if (gateSpec) {
      const classificationStarted = performance.now()
      const classificationResult = await input.provider
        .research(
          { queryText: gateClassificationQueryText(input.queryText, gateSpec) },
          input.signal ?? new AbortController().signal,
        )
        .catch(() => null)
      timings.classification = performance.now() - classificationStarted
      if (classificationResult) {
        const context = buildGeographyGateContext({
          spec: gateSpec,
          classification: classifyStatesFromResearch(classificationResult.prose, gateSpec),
          sources: classificationResult.sources,
        })
        if (context) {
          const bound = gateBoundZctas(rows, context.boundStates)
          if (bound.size > 0) {
            geographyGate = context
            gateBound = bound
          }
        }
      }
    }
  }
  const boundResolved: ResolvedAnswerGeographies =
    geographyGate && gateBound
      ? {
          ...frameResolved,
          zctas: gateBound,
          geographyDisclosures: [
            geographyGate.winnerState
              ? `The cost screen ran inside ${geographyGate.winnerState.name} only: the cited research singles out ${geographyGate.winnerState.name} for the question's first criterion, among the ${stateCountPhrase(geographyGate.classifiedStates.length)} it classifies as meeting it.`
              : `The cost screen ran inside the ${stateCountPhrase(geographyGate.boundStates.length)} the cited research classifies as meeting the question's first criterion: ${geographyGate.boundStates.map((s) => s.name).join(', ')}.`,
            ...frameResolved.geographyDisclosures,
          ],
        }
      : frameResolved
  // Set when any assembly below had to shorten steering text to
  // fit the research route's ceiling; disclosed on the researched
  // criteria's evidence lines before the answer returns.
  let researchQueryTrimmed = false
  if (input.research) {
    const focuses: string[] = []
    const proximity = researchCriteria.find((c) => isProximityCriterion(c.id))
    if (proximity) {
      focuses.push(proximityFocus(proximity.id, decisions.transport).focusText)
    } else if (decisions.transport !== undefined) {
      focuses.push(decisionEffect('transport', decisions.transport).focusText)
    }
    for (const branch of ['school-level', 'budget-anchor'] as const) {
      const landed = decisions[branch]
      if (landed !== undefined) focuses.push(decisionEffect(branch, landed).focusText)
    }
    if (focuses.length > 0) {
      // Composed within the route's ceiling (composeResearchQueryText):
      // the joined text is identical when everything fits — the
      // shape the runner tests pin — and shortens at a word
      // boundary instead of being refused when it does not.
      const composed = composeResearchQueryText(input.queryText, focuses)
      researchQuery = composed.text
      researchQueryTrimmed = composed.trimmed
    }
  }

  // The strict run's latest progress snapshot, retained so the
  // flexible takeover below can re-issue it without its percent
  // (FM-13): the observer seam is fire-and-forget, so the runner
  // keeps the last one it forwarded.
  const lastProgress: { current: RunProgressSnapshot | null } = { current: null }
  // Gate precedence (round 3, 2026-11-04): when the gate formed,
  // it owns this question's shape. The every-state aggregate supply
  // the state-subject reading added upstream is NOT handed to the
  // pipeline — the tax specimen's failure was exactly that supply
  // swallowing a gated question whole (state averages ranked by an
  // unasked measure, the classification nowhere). And the run's
  // intent leads with the gate's extremum metric (the decomposed
  // asked measure), so a parse that named a different measure
  // first cannot re-rank the bounded screen by it. When the gate
  // did not form (no spec, failed classification, empty bound),
  // both stand exactly as shipped — the state path keeps its
  // aggregates and the intent its own order.
  const gateIntent: ValidatedIntent | null =
    geographyGate &&
    gateSpec?.extremumMetricKey &&
    input.intent.metricKeys[0] !== gateSpec.extremumMetricKey
      ? {
          ...input.intent,
          metricKeys: [
            gateSpec.extremumMetricKey,
            ...input.intent.metricKeys.filter((k) => k !== gateSpec!.extremumMetricKey),
          ],
        }
      : null
  const runPipeline = (query: string, forwardProgress: boolean, screenOnly = false) =>
    runAnswerPipeline({
      intent: gateIntent ?? input.intent,
      rows,
      geographyZctas: boundResolved.zctas.size > 0 ? boundResolved.zctas : undefined,
      // The pipeline reads the SAME resolution result this runner
      // resolved from: its per-geography failures and its region
      // readings ride in, so the card's geography lines can never
      // contradict the resolution the card was composed from.
      unresolvedGeographies: frameResolved.unresolvedGeographies,
      geographyDisclosures: boundResolved.geographyDisclosures,
      stateAggregates: geographyGate ? undefined : frameResolved.stateAggregates,
      nearFrame,
      // The geography gate, when the classification resolved above:
      // the pipeline retires the classifying criterion, takes the
      // screen path under the bound (geographyZctas), and composes
      // the gate's evidence, lead, and record.
      geographyGate,
      // Screen-only (the preliminary staging): no research query,
      // so no research stage runs; the criteria decomposition
      // still reaches the pipeline exactly as on the full path,
      // so the preliminary's criteria accounting names every
      // stated criterion — the runner then re-labels the
      // research-served entries as pending (below).
      researchQuery: screenOnly ? undefined : input.research ? query : undefined,
      // Decomposition always reads the reader's original words, never
      // the focused research query: the focus text names modes and
      // levels ("a short public transit ride") that the criterion
      // catalog would otherwise decompose into criteria the reader
      // never stated (measured in-suite: a patch re-run gained a
      // spurious 'amenities' criterion from the word 'transit').
      researchCriteria: decompositionReachesPipeline(input.queryText, input.research)
        ? [input.queryText]
        : undefined,
      queryText: input.queryText,
      provider: input.provider,
      signal: input.signal,
      candidateResolver: input.placeIndex
        ? (names) => resolveCandidatesWithIndex(names, input.placeIndex ?? null)
        : undefined,
      countyAssignments: input.countyIndex
        ? input.countyIndex.assignmentsFor(rows.map((row) => row.zcta))
        : undefined,
      onStage: screenOnly
        ? undefined
        : input.onStage
          ? (stage, subject) =>
              input.onStage!(
                stage === 'screen'
                  ? 'screening'
                  : stage === 'research'
                    ? 'researching'
                    : stage === 'compose'
                      ? 'composing'
                      : 'verifying',
                subject ?? null,
              )
          : undefined,
      onProgress:
        !screenOnly && forwardProgress && input.onProgress
          ? (snapshot) => {
              lastProgress.current = snapshot
              input.onProgress!(snapshot)
            }
          : undefined,
    })

  // Preliminary-first staging (Phase 5, 2026-11-03): for a
  // place-bounded researched question, the deterministic screen
  // composition exists in-process while research takes seconds to
  // minutes of network time. It is composed FIRST — before the
  // branch evaluation and both bookends, which may not block it —
  // and handed to the caller with the research-served criteria
  // re-labeled 'pending': the screen-only composition accounts
  // them with no-research wording ("the lookup did not return"),
  // which is false for a run whose research has not run yet, so
  // those entries are replaced, never merely appended to. Census
  // entries (screen criteria, decomposed readings, the near
  // frame's own entry) are real measurements at this stage and
  // stand as composed. A blocked screen composition hands over
  // nothing: the full run's own refusal owns the terminal, as
  // before. A throw here is defect-class (the full run executes
  // the same deterministic stages first) and propagates to the
  // caller's compose-failure terminal, unchanged.
  //
  // Scope: shapes with a resolved ZIP set in hand (place-bounded
  // and state-screen questions). A BREADTH run (breadthShapeFor:
  // set-form, one state, a poled criterion) is excluded — its
  // roster is research-born, so a screen-only pass has no honest
  // preliminary to show, and its progressive surface already
  // exists (interim places + pass progress, Lane A7).
  if (
    input.research &&
    input.onPreliminary &&
    boundResolved.zctas.size > 0 &&
    breadthShapeFor({
      queryText: input.queryText,
      intent: input.intent,
      researchCriteria,
    }) === null
  ) {
    const preliminaryStarted = performance.now()
    const screened = await runPipeline(input.queryText, false, true)
    timings.preliminary = performance.now() - preliminaryStarted
    if (screened.status !== 'blocked') {
      // The gate's classifying criterion is NOT pending at this
      // stage: its classification research already landed (it ran
      // before this preliminary was composed), and the screen-only
      // composition carries its real gate evidence entry. Every
      // other research-served criterion is still in flight and is
      // re-labeled pending below.
      const pendingLabels = new Set(
        researchCriteria
          .filter((c) => !c.decomposedMetricKey && c.label !== geographyGate?.criterionLabel)
          .map((c) => c.label),
      )
      const kept = screened.criterionEvidence.filter(
        (entry) => !(entry.kind === 'research' && pendingLabels.has(entry.criterion)),
      )
      const keptLabels = new Set(kept.map((entry) => entry.criterion))
      const pendingEntries = researchCriteria
        .filter((c) => !c.decomposedMetricKey && pendingLabels.has(c.label) && !keptLabels.has(c.label))
        .map((c) => ({
          criterion: c.label,
          kind: 'research' as const,
          status: 'pending' as const,
          detail:
            'Research is still running for this criterion; this preliminary answer is updated when it lands.',
          sourceUrls: [] as string[],
        }))
      input.onPreliminary({
        ...screened,
        preliminary: true,
        criterionEvidence: [...kept, ...pendingEntries],
      })
    }
  }

  // Branch evaluation at the screen -> research boundary (plan C7):
  // evaluated BEFORE the pipeline runs so a landed decision from an
  // earlier question is already in the research focus above, and a
  // fresh proposal can float over the working state. The pipeline
  // never waits on it.
  let proposal: ComposedAnswer['decisionProposal']
  if (stack && input.research) {
    const started = performance.now()
    proposal = await evaluateDecisionProposal({
      queryText: input.queryText,
      intent: input.intent,
      research: input.research,
      decisions,
      closedBranches: stack.closedBranches,
      jevTransport: stack.jevTransport,
    })
    timings.branch = performance.now() - started
  }

  // Top bookend (plan C2): after screen inputs exist, before
  // research runs inside the pipeline. An unsound verdict's named
  // objections are recorded on the answer as constraints; the
  // deterministic stages own execution and the run proceeds (a
  // second unsound verdict would proceed anyway, per plan).
  let planObjections: string[] | undefined
  if (stack) {
    const started = performance.now()
    input.onStage?.('wonder-plan')
    const planPacket = buildPlanPacket({
      question: input.queryText,
      intent: {
        mode: input.intent.mode,
        geographies: [...input.intent.geographies],
        metricKeys: [...input.intent.metricKeys],
      },
      criteria: [
        ...screenCriteriaFromIntent(input.intent).criteria.map((c) => ({
          kind: 'census' as const,
          text: c.metricKey,
        })),
        ...researchCriteria.map((c) => ({ kind: 'research' as const, text: c.label })),
      ],
      subsetSummary: { count: rows.length, ranges: [] },
      decisions: { ...decisions } as Record<string, string>,
    })
    const verdict = await settleBookend(() => stack.planTransport(planPacket))
    timings.plan = performance.now() - started
    if (verdict?.verdict === 'unsound') {
      planObjections = verdict.objections.map((o) => `${o.code}: ${o.detail}`)
    }
  }

  const pipelineStarted = performance.now()
  let answer = await runPipeline(researchQuery, true)
  timings.pipeline = performance.now() - pipelineStarted
  if (answer.status === 'blocked') return null

  // Flexible completion fall-through (2026-11-02, owner directive;
  // core/ai/flexible.ts): research succeeded and named places, but
  // the strict lane could not compose a card from them, so the
  // strict answer is the bare not-matched note. The completion
  // drafts on the hourglass seams and must pass the extended
  // validator before it replaces the note; any failure along the
  // way returns null here and the strict terminal stands, unchanged.
  // Provider failures reach this branch only as the pipeline's
  // honest-note terminal (compose-degradation cure, 2026-11-03):
  // it carries no noCensusMatch marker and names no places, so
  // the material test below excludes it — a total failure grounds
  // no completion. Neither do safety refusals ('blocked' returned
  // null above) or a genuine Census screen with no match (status
  // 'empty' with no research material).
  //
  // Trigger widening (2026-11-02, flexible-trigger cure): the
  // fall-through keys on the MATERIAL — research-named places
  // present on the answer — not only on the noCensusMatch marker.
  // The marker remains a sufficient condition (it is stamped
  // exactly at the research-mismatch terminal), but any 'empty'
  // terminal of a researched question that carries research-named
  // places engages the lane: what research returned decides the
  // rescue, not which internal terminal stamped the answer. The
  // multi-pass partial-failure terminal that motivated the widening
  // is cured one layer down (researchPerCriterion's partial
  // tolerance returns the gathered material instead of throwing it
  // away), and lands here through the same material test.
  let flexibleVerification: {
    wonder: 'verified' | 'concerns' | 'not-run'
    wonderConcerns?: string[]
    jev: { roundsUsed: number; passed: boolean } | 'not-run'
  } | null = null
  // The material test (Lane completion K0, 2026-11-03): the
  // fall-through engages on ANY research material the strict run
  // gathered — the full extraction record, the unresolved record,
  // or surviving cited claims — not only on the noCensusMatch
  // marker and the extraction stamp. The owner's no-loophole
  // directive makes the completion the terminal of last resort
  // for every lane shape: a researched place question that ends
  // with zero named places and any material in hand completes
  // here, whatever internal terminal stamped the answer. The
  // fences stand: a total research failure carries no names and
  // no claims, so it never satisfies the test; a genuine Census
  // screen with no match and no research material likewise; the
  // researched-question fence (researchCriteria present, or the
  // marker) keeps an unresearched data answer out of the lane.
  const hasResearchMaterial =
    answer.noCensusMatch === true ||
    (answer.researchNamedPlaces?.length ?? 0) > 0 ||
    answer.unresolvedCandidates.length > 0 ||
    answer.generalClaims.length > 0
  if (
    stack &&
    answer.status === 'empty' &&
    (answer.researchCriteria.length > 0 || answer.noCensusMatch === true) &&
    hasResearchMaterial
  ) {
    // Lane A9 FM-13: the flexible lane owns the run from here, and
    // its shape has no honest percent (the A7 contract — Jev-loop
    // totals are unknowable). The strict stage's final snapshot
    // would otherwise persist in the store and hold the progress
    // bar at 100% through the whole flexible stage: a bar element
    // on a no-percent shape (measured on the A7 live run sheet).
    // The snapshot is re-issued with its total nulled — percent
    // reads null and the bar unmounts — while its counts stay,
    // because they are true: the strict checks did run, and the
    // counts line and the terminal Complete strip read them
    // through the criteria total (run-progress's own fallback).
    const settledProgress = lastProgress.current
    if (settledProgress) {
      input.onProgress?.({ ...settledProgress, totalUnits: null })
    }
    const completion = await composeFlexibleCompletion({
      queryText: input.queryText,
      strictAnswer: answer,
      rows,
      criteria: loopCriteriaFor(input.intent, input.research, input.queryText),
      deps: {
        flexibleTransport: stack.flexibleTransport,
        jevTransport: stack.jevTransport,
        verifyTransport: stack.verifyTransport,
      },
      onStage: input.onStage ? (stage) => input.onStage!(stage) : undefined,
    })
    if (completion) {
      answer = {
        ...answer,
        status: 'flexible',
        flexible: completion.flexible,
        // The no-place evidence entries restamp (Lane completion
        // K0): the strict run's FM-18 entries state that the
        // research's material produced no place that could be
        // shown — true of the strict terminal the completion
        // replaces, and false on the card the reader now sees,
        // which shows those places with their evidence labels.
        // Exactly the entries carrying the shared no-place detail
        // restamp to served-by-the-completion; failed-lookup
        // entries (a different detail) and Census entries are
        // untouched, and the restamp runs only when the
        // completion actually names places.
        ...(completion.flexible.places.length > 0
          ? {
              criterionEvidence: answer.criterionEvidence.map((entry) =>
                entry.kind === 'research' &&
                entry.status === 'not_measurable' &&
                entry.detail === NO_PLACE_LOOKUP_DETAIL
                  ? {
                      ...entry,
                      status: 'met' as const,
                      detail:
                        'Served by the completed answer below — the places the research ' +
                        'named are shown with their evidence labels.',
                    }
                  : entry,
              ),
            }
          : {}),
        summary:
          'The cited research named places for the stated criteria, but none could be ' +
          'matched to Census data. This answer is completed from the research and the ' +
          'model’s own knowledge, with every place and figure labelled by the evidence ' +
          'behind it.',
      }
      flexibleVerification = completion.verification
      Object.assign(timings, completion.timings)
    }
  }

  const verification: NonNullable<ComposedAnswer['verification']> = {
    wonder: flexibleVerification?.wonder ?? 'not-run',
    jev: flexibleVerification?.jev ?? 'not-run',
    ...(flexibleVerification?.wonderConcerns
      ? { wonderConcerns: flexibleVerification.wonderConcerns }
      : {}),
    ...(planObjections ? { planObjections } : {}),
  }

  // The Jev loop (plan C4) runs only over a verified answer: compose
  // -> verify (inside the pipeline) -> J-LOOP -> patch -> verify ->
  // J-LOOP, max 2 rounds, best grounded version ships.
  if (stack && answer.status === 'verified') {
    const criteria = loopCriteriaFor(input.intent, input.research, input.queryText)
    if (criteria.length > 0) {
      const roundTimings: number[] = []
      const patchTimings: number[] = []
      input.onStage?.('jev')
      const outcome = await runJevLoop(answer, {
        transport: stack.jevTransport,
        criteria,
        evidenceLabels: answer.criterionEvidence.map(
          (entry) => `${entry.criterion}: ${entry.status}`,
        ),
        sourceCount: answer.sources.length,
        textOf: answerTextForLoop,
        verifyOf: (candidate) => candidate.status === 'verified',
        patch: async ({ gaps }) => {
          // Patch, don't regenerate (plan C4): the revision carries
          // the named gaps verbatim as the research focus. This
          // pipeline's compose is deterministic code over the
          // research stage's findings — there is no compose-stage
          // model route in the provider contract — so the targeted
          // patch re-runs the pipeline with the gaps as the research
          // instruction; verify inside the pipeline re-runs before
          // the candidate can enter the loop state.
          if (!input.research) return null
          // The gap instruction is composed within the research
          // route's ceiling like every other assembly: appended
          // raw, one patch round on a focused query measured 572
          // chars against the 500 ceiling and the route refused
          // every iterative pass (2026-11-03).
          const composed = composeResearchQueryText(researchQuery, [
            `Address these gaps: ${gaps.join('; ')}`,
          ])
          if (composed.trimmed) researchQueryTrimmed = true
          const patched = await runPipeline(composed.text, false)
          return patched.status === 'blocked' ? null : patched
        },
        onTiming: (stage, ms) => {
          if (stage === 'jev-round') roundTimings.push(ms)
          else patchTimings.push(ms)
        },
      })
      roundTimings.forEach((ms, i) => {
        timings[`jev-round-${i}`] = ms
      })
      patchTimings.forEach((ms, i) => {
        timings[`patch-${i}`] = ms
      })
      if (outcome.ran) {
        answer = outcome.answer
        const bestVersion =
          outcome.state.versions.find((v) => v.answer === outcome.answer) ??
          outcome.state.versions[0]!
        verification.jev = {
          roundsUsed: outcome.state.roundsUsed,
          passed:
            Object.values(bestVersion.noul).every((p) => p >= 0.8) &&
            bestVersion.relevance >= 1.5 &&
            bestVersion.completeness >= 1.5,
        }
      }
    }
  }

  // The nearby blend lands in the proximity criterion's evidence
  // (plan C9): the mode basis is stated inside the evidence, never a
  // silent single-mode assumption.
  if (input.research && answer.criterionEvidence.length > 0) {
    const proximity = researchCriteria.find((c) => isProximityCriterion(c.id))
    if (proximity) {
      const modes = proximityFocus(proximity.id, decisions.transport).modes
      const blend =
        decisions.transport !== undefined
          ? decidedEvidenceText({
              decision: decisions.transport === 'no-car' ? 'no-car' : 'car',
              modes,
              findings: [],
            })
          : blendEvidenceText({ modes, findings: [] })
      answer = {
        ...answer,
        criterionEvidence: answer.criterionEvidence.map((entry) =>
          entry.criterion === proximity.label ? { ...entry, detail: blend } : entry,
        ),
      }
    }
  }

  // Ceiling disclosure: when an assembly above shortened the
  // research request's steering text to fit the research route's
  // length limit, the researched criteria's evidence lines say so
  // — the reader's question and stated criteria always rode in
  // full (they travel in their own fields), and the accounting
  // never presents a shortened request as the whole one.
  if (researchQueryTrimmed && answer.criterionEvidence.length > 0) {
    answer = {
      ...answer,
      criterionEvidence: answer.criterionEvidence.map((entry) =>
        entry.kind === 'research'
          ? {
              ...entry,
              detail:
                `${entry.detail} The research request text was shortened to fit ` +
                `the research service's length limit; the question and the ` +
                `stated criteria were carried in full.`,
            }
          : entry,
      ),
    }
  }

  // Bottom bookend (plan C5): after the loop settles, before display.
  if (stack && answer.status === 'verified') {
    const started = performance.now()
    input.onStage?.('wonder-verify')
    const verifyPacket = buildVerifyPacket({
      summary: answer.summary,
      places: answer.places.map((place) => ({
        name: place.name,
        figures: place.figures.map((f) => ({ key: f.key, value: f.value })),
      })),
      evidence: answer.criterionEvidence.map((entry) => ({
        criterion: entry.criterion,
        status: entry.status,
        detail: entry.detail,
      })),
      sources: answer.sources.map((s) => ({ title: s.title, url: s.url })),
      verifySummary: `status ${answer.status}; ${answer.places.length} places; ${answer.failures.length} verify failures`,
      placeDisplayLimit: 10,
    })
    const verdict = await settleBookend(() => stack.verifyTransport(verifyPacket))
    timings.verify = performance.now() - started
    verification.wonder = wonderLabelFor(verdict)
    if (verdict?.verdict === 'concerns') {
      verification.wonderConcerns = verdict.concerns.map((c) => c.detail)
    }
  }

  return {
    ...answer,
    verification,
    timings,
    ...(proposal ? { decisionProposal: proposal } : {}),
  }
}

/**
 * Refine an answer with a landed decision (plan C7): the decision is
 * written to session state, ONLY the affected stage is re-prompted
 * (the research stage, via the decision's focus — the deterministic
 * screen is unchanged by every catalogued branch), and the refined
 * answer replaces the provisional in place with the refinement note,
 * re-passing verify + J-LOOP inside composeAnswerForRequest. A
 * refinement that fails verify keeps the provisional.
 */
export async function refineAnswerForRequest(input: {
  intent: ValidatedIntent
  queryText: string
  rows: readonly AreaRow[]
  resolved: ResolvedAnswerGeographies
  provider: MuseProvider
  research: boolean
  signal?: AbortSignal
  placeIndex?: PlaceIndex | null
  countyIndex?: CountyIndex | null
  /** Centroids for the near frame, forwarded to the refinement's compose. */
  centroids?: readonly ZctaPoint[] | null
  stack?: ConversationalStackDeps | false
  /** The provisional answer the decision floated over. */
  provisional: ComposedAnswer
  branch: BranchId
  option: string
  /** Staged-status observer, forwarded to the refinement's compose (item 17). */
  onStage?: (stage: StageId, subject?: string | null) => void
}): Promise<ComposedAnswer> {
  writeSessionDecision(input.branch, input.option)
  const baseDecisions: DecisionsRecord =
    input.stack === false
      ? {}
      : { ...(input.stack?.decisions ?? readSessionDecisions()), [input.branch]: input.option }
  try {
    const refined = await composeAnswerForRequest({
      intent: input.intent,
      queryText: input.queryText,
      rows: input.rows,
      resolved: input.resolved,
      provider: input.provider,
      research: input.research,
      signal: input.signal,
      placeIndex: input.placeIndex,
      countyIndex: input.countyIndex,
      centroids: input.centroids,
      stack:
        input.stack === false
          ? false
          : { ...(input.stack ?? {}), decisions: baseDecisions },
      onStage: input.onStage,
    })
    if (!refined || refined.status !== 'verified') return input.provisional
    return { ...refined, refinementNote: refinementNote(input.branch, input.option) }
  } catch {
    return input.provisional
  }
}
