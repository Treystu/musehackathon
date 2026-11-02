import {
  decomposeResearchCriteria,
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
import { stateCodeForGeography } from '../../core/ai/national-screen'
import type { CountyIndex } from '../../core/zcta-county-index'
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
  /** Landed decisions for this run; defaults to the session record. */
  decisions?: DecisionsRecord
  /** Branches already closed this session (never re-proposed). */
  closedBranches?: ReadonlySet<string>
}

function defaultStack(deps: ConversationalStackDeps | undefined): Required<
  Pick<ConversationalStackDeps, 'jevTransport' | 'planTransport' | 'verifyTransport'>
> & { decisions: DecisionsRecord; closedBranches: ReadonlySet<string> } {
  const bookends = createHttpBookendTransports()
  return {
    jevTransport: deps?.jevTransport ?? createHttpJevTransport(),
    planTransport: deps?.planTransport ?? bookends.plan,
    verifyTransport: deps?.verifyTransport ?? bookends.verify,
    decisions: deps?.decisions ?? readSessionDecisions(),
    closedBranches: deps?.closedBranches ?? new Set(),
  }
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
}): Promise<ComposedAnswer | null> {
  if (input.resolved.unresolvable) return null
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
    if (focuses.length > 0) researchQuery = `${input.queryText} ${focuses.join(' ')}`
  }

  const runPipeline = (query: string) =>
    runAnswerPipeline({
      intent: input.intent,
      rows,
      geographyZctas: input.resolved.zctas.size > 0 ? input.resolved.zctas : undefined,
      researchQuery: input.research ? query : undefined,
      // Decomposition always reads the reader's original words, never
      // the focused research query: the focus text names modes and
      // levels ("a short public transit ride") that the criterion
      // catalog would otherwise decompose into criteria the reader
      // never stated (measured in-suite: a patch re-run gained a
      // spurious 'amenities' criterion from the word 'transit').
      researchCriteria: input.research ? [input.queryText] : undefined,
      queryText: input.queryText,
      provider: input.provider,
      signal: input.signal,
      candidateResolver: input.placeIndex
        ? (names) => resolveCandidatesWithIndex(names, input.placeIndex ?? null)
        : undefined,
      countyAssignments: input.countyIndex
        ? input.countyIndex.assignmentsFor(rows.map((row) => row.zcta))
        : undefined,
    })

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
    const verdict = await stack.planTransport(
      buildPlanPacket({
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
      }),
    )
    timings.plan = performance.now() - started
    if (verdict?.verdict === 'unsound') {
      planObjections = verdict.objections.map((o) => `${o.code}: ${o.detail}`)
    }
  }

  const pipelineStarted = performance.now()
  let answer = await runPipeline(researchQuery)
  timings.pipeline = performance.now() - pipelineStarted
  if (answer.status === 'blocked') return null

  const verification: NonNullable<ComposedAnswer['verification']> = {
    wonder: 'not-run',
    jev: 'not-run',
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
          const patched = await runPipeline(
            `${researchQuery} Address these gaps: ${gaps.join('; ')}`,
          )
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

  // Bottom bookend (plan C5): after the loop settles, before display.
  if (stack && answer.status === 'verified') {
    const started = performance.now()
    const verdict = await stack.verifyTransport(
      buildVerifyPacket({
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
      }),
    )
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
  stack?: ConversationalStackDeps | false
  /** The provisional answer the decision floated over. */
  provisional: ComposedAnswer
  branch: BranchId
  option: string
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
      stack:
        input.stack === false
          ? false
          : { ...(input.stack ?? {}), decisions: baseDecisions },
    })
    if (!refined || refined.status !== 'verified') return input.provisional
    return { ...refined, refinementNote: refinementNote(input.branch, input.option) }
  } catch {
    return input.provisional
  }
}
