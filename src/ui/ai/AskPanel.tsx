import { useRef, useSyncExternalStore } from 'react'
import { decideAskPath } from '../../core/ai/byo'
import { hasMetaKey } from '../../core/ai/meta-key'
import {
  assessTranscript,
  reconcileSpokenIntent,
  type MicStorage,
} from '../../core/ai/mic'
import type {
  IntentResult,
  MuseProvider,
  ResearchResult,
  TranscribeResult,
  ValidatedIntent,
} from '../../core/ai/provider'
import { diagnostics } from '../../core/ai/diagnostics'
import {
  SALARY_FIGURE_RE,
  decomposeResearchCriteria,
  filterWorkingNarration,
  hasUnclaimedCriterionContent,
  type AnswerSource,
  type ResearchCriterion,
} from '../../core/ai/answer'
import { canRun, validateIntent, withRunnability } from '../../core/ai/intent-schema'
import {
  INQUIRY_WAVE_OFF_CLOSE,
  dataIntentForHybrid,
  isInquiryWaveOff,
  markInquiryWavedOff,
  readInquirySession,
  resolveDomainClassification,
} from '../../core/ai/general'
import {
  NATIONAL_SCREEN_LABELS,
  completeParsedBoundedScreen,
  rescueNationalScreen,
  stateCodeForGeography,
} from '../../core/ai/national-screen'
import { STATE_NAME_BY_CODE } from '../../core/sweep/states'
import { removeGeography } from '../../core/ai/intent-edit'
import { DISCLOSURE_TEXT, hermeticStubValidator, type Validator } from '../../core/ai/validator'
import type { ProxyError } from '../../core/ai/proxy-errors'
import { censusLoadSentence } from '../GuidedTour'
import { HelpTip } from './HelpTip'
import { ClarificationPanel, type ClarificationCandidates } from './ClarificationPanel'
import { IntentEditor } from './IntentEditor'
import { ExplainOnAsk } from './ExplainOnAsk'
import { MicInput, type MicRecognizer, type MicRecorder } from './MicInput'
import { StagedStatus } from './StagedStatus'
import {
  AskSessionStore,
  type AnswerRequestOrigin,
  type PanelResearchState,
} from './session-store'
import { pickAckOpener, researchAck } from './ack'
import type { ExplanationState } from './ExplainBox'
import type { FigureInput } from './FigureCard'

export const SPOKEN_NUMBER_CORRECTION_NOTE =
  'A figure in the understood request did not match the numbers actually said, so it was taken out; the request below runs on the numbers that were said. The words stand in the box above, where they can be corrected.'

export const EMPTY_TRANSCRIPT_NOTE =
  'No speech was captured. The typed box above still works fully, or try speaking again.'

export const RAW_TEXT_DISCLOSURE =
  'Free-text Ask sends the words you type to the wording helper. The figures still come from CivicScope.'

/**
 * Coverage honesty for criteria this dataset does not contain
 * (owner example, 2026-11-01: a move-to-Nevada question asking for
 * somewhere "not Republican"). The figures are Census Bureau data;
 * voter registration, party affiliation, and election results are
 * not in them, so a politics screen cannot be run or implied. When
 * the reader's words ask for one, say so plainly and let everything
 * else in the question proceed.
 */
export const POLITICS_COVERAGE_NOTE =
  'One part of that question sits outside this data: these figures are Census Bureau data, with no voter registration, party affiliation, or election results, so places cannot be screened by politics here. Everything else in the question is handled below.'

const POLITICS_QUESTION_RE =
  /\b(republicans?|democrats?|democratic|liberals?|conservatives?|political|politics|party affiliation|voter registration|red state|blue state)\b/i

export function politicsCoverageNote(queryText: string | undefined): string {
  return queryText && POLITICS_QUESTION_RE.test(queryText) ? POLITICS_COVERAGE_NOTE : ''
}

/**
 * The standalone research section's prose, filtered (Lane
 * completion K9): the section renders what it stores verbatim, so
 * the model's working narration ("I'll research...", interim
 * standings, raw source titles) could head the findings raw. The
 * answer-card path drops the same class inside compose; this
 * applies that filter (filterWorkingNarration, answer.ts) per
 * paragraph, so the section shows findings in their paragraph
 * shape and narration nowhere. An all-narration return filters
 * to the empty string, and the caller stores the run as
 * unavailable — there is no finding to show.
 */
export function filterStandaloneResearchProse(
  prose: string,
  sources: readonly AnswerSource[],
): string {
  return prose
    .split(/\n\n+/)
    .map((para) => filterWorkingNarration(para, sources).prose)
    .filter((para) => para.length > 0)
    .join('\n\n')
}

/**
 * Questions carrying criteria the Census data cannot serve — schools,
 * amenities, safety, political character, lifestyle, services — get a
 * grounded web answer alongside the figures (owner directive,
 * 2026-11-01: any question answerable). This lexical screen decides
 * only whether the research path fires; the research model does the
 * answering, with sources, and the politics coverage note above
 * remains the fallback when research itself cannot be reached.
 */
/**
 * The politics-characterization arm of the shipped lexicon, kept as
 * an engagement HINT (see needsResearch): political character is
 * research-servable content with no catalog entry and no measure
 * reading, and a non-superlative phrasing ("towns that are
 * liberal") can leave decomposition with nothing while the question
 * plainly asks research a question. The characterization FENCES
 * (politicsCoverageNote, PROTECTED_CHARACTERIZATION_RE) are a
 * separate posture and stay exactly where they are — this arm
 * engages the research call, never the handoff.
 */
const POLITICS_CHARACTERIZATION_RE =
  /\b(liberals?|conservatives?|republicans?|democrats?|democratic|political|politics|voter|voting|red state|blue state)\b/i

/**
 * Whether the question carries criteria the Census screen cannot
 * serve, and so engages the research stage (Lane A9 FM-1 — the
 * generality program's primary cure). The derivation is from
 * CRITERION CONTENT, not from a hand-maintained word list: the
 * question engages exactly when its decomposition
 * (decomposeResearchCriteria) yields a criterion no Census measure
 * serves — a named research-class catalog entry, or the combined
 * class (the whole-question carry and per-segment residue
 * criteria), which decomposition now emits only for criterion
 * content no layer claims. The shipped word list decided
 * engagement on its own, and every criterion word it happened not
 * to contain failed the same way (measured by the phase-1 battery:
 * "best weather", "best beer selection", "strongest job market",
 * "most fun things to do", "lowest flood risk", "most charming"
 * all read needsResearch false, the combined criterion was dropped
 * with it, and the terminal was a Census screen stamped not
 * measurable — while the same questions, engaged by hand, served
 * through the general path every time). The lexicon demotes to
 * accelerator hints for the two arms decomposition cannot see: a
 * stated salary (the catalog's own SALARY_FIGURE_RE — its entry is
 * research-class, and the figure test is decomposition's own
 * pattern, shared so the layers cannot drift) and political
 * characterization (POLITICS_CHARACTERIZATION_RE above). Audience
 * words the old list carried (families, kids, children) engage
 * nothing on their own: they state who is asking, not a criterion,
 * and letting them engage was the FM-3c spurious-combined family.
 * A criterion decomposed onto a Census metric (cost of living,
 * internet access) does NOT engage: the metric serves it, and a
 * web pass would spend research on a criterion the data answers.
 */
export function needsResearch(queryText: string | undefined): boolean {
  if (!queryText) return false
  if (SALARY_FIGURE_RE.test(queryText)) return true
  if (POLITICS_CHARACTERIZATION_RE.test(queryText)) return true
  // Commute-duration arm: "shortest commute" is research-servable
  // content decomposition cannot see — the superlative scan claims
  // "commute" as a measure head, yet the registry carries no
  // commute-duration metric for the screen to serve it with (the
  // handoff battery carries these questions as combined-criterion
  // research questions). A duration word beside "commute" is the
  // arm; a bare "commuting workers" count is a Census measure and
  // does not fire it.
  if (/\bcommut\w*\b[^.!?]{0,25}\b(?:short|long|duration|time|length|minutes?|hours?)\b|\b(?:shortest|longest|quickest)\s+commut\w*\b/i.test(queryText)) return true
  const decomposed = decomposeResearchCriteria(queryText)
  // A named research-class criterion engages on its own content.
  if (decomposed.some((c) => c.id !== 'combined' && !c.decomposedMetricKey)) return true
  // The combined class engages only when the question carries
  // criterion content no layer claims — NOT for the criteria-less
  // total-miss fallback ("best place to raise a family" decomposes
  // to the combined carry yet states no parseable criterion, and
  // its shipped posture is to keep clarifying, not to research).
  if (decomposed.some((c) => c.id === 'combined')) {
    return hasUnclaimedCriterionContent(queryText, decomposed)
  }
  return false
}

/**
 * Whether a runnable intent is served by the answer pipeline
 * (core/ai/answer.ts): a sweep (its bounds are the screen's criteria,
 * placeless ones included — the national screen), any intent carrying
 * filters, or a lookup/compare naming places and measures, which the
 * pipeline renders as the plain figure card. Similarity is the one
 * runnable mode with no pipeline shape: the screen cannot express
 * "like this place", so it keeps the existing views alone.
 */
export function answerEligible(intent: ValidatedIntent): boolean {
  if (isResearchFirstHandoff(intent)) return true
  if (intent.mode === 'sweep_filter') return true
  if (intent.filters.length > 0) return true
  return (
    (intent.mode === 'lookup' || intent.mode === 'compare') &&
    intent.geographies.length > 0 &&
    intent.metricKeys.length > 0
  )
}

/**
 * Protected-class / characterization content in the reader's own
 * words. The research-first handoff below must never become a path
 * around the safety posture: when the asking is done by a protected
 * characteristic (or a political character — politicsCoverageNote
 * above), the clarification and the upstream refusals keep their
 * job, exactly as before this handoff existed. The list is lexical
 * and deliberately narrow — it gates only the handoff, never the
 * parse, the clarification, or the standalone research fallback.
 */
const PROTECTED_CHARACTERIZATION_RE =
  /\b(race|racial|ethnic|ethnicity|black|white|hispanic|latino|latina|asian|african american|native american|indigenous|religion|religious|muslim|jewish|hindu|national origin|demographics?)\b/i

/**
 * The researched criteria a question carries, for the handoff
 * discriminator: the shipped decomposition catalog's own split when
 * it splits anything, and — when outside-knowledge triggers fire
 * (needsResearch) but the catalog splits nothing — the catalog's
 * combined-criterion carry, so a question whose outside criteria the
 * catalog has no entry for ("best libraries and quietest streets")
 * is still research-first servable as one combined criterion.
 * The combined carry excludes politics questions (the coverage-note
 * posture owns their fallback), and researchFirstHandoff refuses a
 * politics-characterization question outright, split or not.
 */
export function researchFirstCriteria(
  queryText: string | undefined,
): ResearchCriterion[] {
  if (!queryText || queryText.trim() === '') return []
  const decomposed = decomposeResearchCriteria(queryText)
  if (decomposed.some((criterion) => criterion.id !== 'combined')) return decomposed
  if (decomposed.length > 0 && needsResearch(queryText) && !politicsCoverageNote(queryText)) {
    return decomposed
  }
  return []
}

/**
 * Genuine place ambiguity, read from what the parse actually
 * carries. The parse has no separate alternatives field: candidate
 * places for one ambiguous name arrive AS the intent's geographies
 * (that is the list clarificationCandidatesFor hands the panel), so
 * ambiguity is two or more DISTINCT geographies sharing one place
 * name — "Springfield, IL" beside "Springfield, MO". Two different
 * names ("Hilo" beside "Austin") are two named places, not an
 * ambiguity. Limit, pinned in tests: a parse that collapses an
 * ambiguous name to a single geography is indistinguishable from a
 * resolved one in this state, and hands off — resolution then
 * happens through the place index in the runner, the same authority
 * execution uses.
 */
export function hasAmbiguousPlaceCandidates(geographies: readonly string[]): boolean {
  const variantsByName = new Map<string, Set<string>>()
  for (const geography of geographies) {
    const name = (geography.split(',')[0] ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    const variants = variantsByName.get(name) ?? new Set<string>()
    variants.add(geography.trim().toLowerCase())
    variantsByName.set(name, variants)
  }
  for (const variants of variantsByName.values()) {
    if (variants.size > 1) return true
  }
  return false
}

/**
 * Parse grounding (Lane completion K1b, 2026-11-03): a clarifying
 * intent's geographies must be places the reader's own question
 * names. The parse chain is stateless by construction — the panel
 * sends empty geography hints, the route and provider pass the
 * question text only, runQuery clears the panel intent at ask
 * time, and clarification candidates derive from the current parse
 * alone — so no client state can carry a prior run's place into a
 * new question. What CAN arrive is a model reply that carries one
 * anyway (the specimen, on production 6027031 under recorded
 * contention: "What is the most liberal city in Texas?" asked after
 * a Hilo comparison clarified as a comparison holding "Hilo, HI",
 * a place the question never names, presented as the reader's own
 * choice already made). The intent prompt's own contract is "keep
 * every place or state the question names in geographies", so a
 * geography the question does not ground is outside the reply's
 * contract by definition. This guard enforces the contract at the
 * seam where a reply settles into the understood request, reading
 * only the reader's words — the same posture as the national-screen
 * rescue beside it. It applies only to intents that still need
 * clarification (a runnable parse is the model's settled reading
 * and runs untouched), and a dropped geography costs at most a
 * re-pick in the panel; a kept foreign geography would run, or
 * stand as the reader's choice, on words they never wrote.
 */
export function geographyGroundedInQuestion(geography: string, queryText: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const text = ` ${normalize(queryText)} `
  const contains = (phrase: string) => phrase !== '' && text.includes(` ${phrase} `)
  if (contains(normalize(geography))) return true
  if (contains(normalize(geography.split(',')[0]!))) return true
  // State equivalence: a geography that names a state, by code or
  // by full name, is grounded when the question names that state in
  // either form ("TX" in the words grounds "Texas" in the reply).
  const code = stateCodeForGeography(geography)
  if (code) {
    if (contains(code.toLowerCase())) return true
    const name = STATE_NAME_BY_CODE[code]
    if (name && contains(normalize(name))) return true
  }
  return false
}

/** The intent with every ungrounded geography removed (see above). */
export function dropUngroundedGeographies(
  intent: ValidatedIntent,
  queryText: string | undefined,
): ValidatedIntent {
  if (!queryText || !intent.clarificationNeeded || intent.geographies.length === 0) return intent
  const kept = intent.geographies.filter((g) => geographyGroundedInQuestion(g, queryText))
  if (kept.length === intent.geographies.length) return intent
  return withRunnability({ ...intent, geographies: kept })
}

/**
 * The research-first handoff (owner requirement, 2026-11-02 08:29
 * HST: a partially servable question gets a partial grounded
 * answer, never a dead-end clarification — his headline example is
 * "Which area has the best schools and the fewest fast food
 * restaurants?"). The Answer Layer already serves such questions
 * (answer.ts research-first: research, extract, resolve through the
 * place index, pull Census figures, compose with per-criterion
 * evidence), but the live Ask path never reached it: an
 * external-only parse clarifies, and clarification was the end.
 *
 * The discriminator, built from the parse state that actually
 * exists. A clarifying intent hands off when ALL of these hold:
 *  - nothing-to-screen: the parse carries no Census bound (no
 *    filters), so clarification's only forward path would be
 *    inventing a Census question the reader did not ask. A retained
 *    metricKey is not runnable content on its own — it is a measure
 *    to SHOW — and since P3 step 2 it rides along as chosen rather
 *    than excluding the handoff (see the function body);
 *  - not ambiguous-identity: the geographies are not rival
 *    candidates for one name (hasAmbiguousPlaceCandidates) — that
 *    is the case the clarification panel exists to resolve;
 *  - the question decomposes into at least one researched
 *    criterion (researchFirstCriteria) — a criteria-less question
 *    ("best place to raise a family") decomposes to nothing and
 *    keeps clarifying, the safety corpus posture;
 *  - no protected-class or characterization content is doing the
 *    asking (PROTECTED_CHARACTERIZATION_RE for protected classes,
 *    politicsCoverageNote for political character).
 * A parse that fails validation upstream — the policy-blocked
 * shape — never reaches this function: accept() runs it only on a
 * validated intent, so refusals keep their path untouched.
 *
 * The handoff intent is the parse verbatim (mode and geographies
 * carried — the geography bound rides into the pipeline's research
 * places and figure pull) with the clarification flag cleared.
 * That state is the marker: withRunnability is the single owner of
 * the flag and stamps clarificationNeeded = !canRun for every
 * parse, editor, and clarification path, so a settled flag on an
 * intent canRun still rejects is a state only this handoff
 * produces (isResearchFirstHandoff).
 */
/** Intents this module's handoff produced, by reference: the marker
 * that lets a metric-carrying handoff (P3 step 2) be told apart from
 * an ordinary settled intent, since the intent shape itself is the
 * parse verbatim and carries no spare field for the distinction. */
const handedOffIntents = new WeakSet<ValidatedIntent>()

export function researchFirstHandoff(
  intent: ValidatedIntent,
  queryText: string | undefined,
): ValidatedIntent | null {
  if (!intent.clarificationNeeded || canRun(intent)) return null
  // Mixed-intent inclusivity (P3 step 2, battery A3): a retained
  // metricKey no longer excludes the handoff. The shipped exclusion
  // dropped every servable part of "warm + affordable homes +
  // hospitals": the parse kept median_home_value, both partial-answer
  // paths refused it for carrying that key, and the panel then
  // presented the retained measure back as still missing. Now the
  // retained measure rides into the pipeline as a chosen measure
  // (its figures are pulled and shown), the external criteria are
  // researched or labelled, and the partial answer ships. A filter
  // still excludes: a filtered intent is screen-servable as asked.
  if (intent.filters.length > 0) return null
  if (hasAmbiguousPlaceCandidates(intent.geographies)) return null
  if (!queryText || PROTECTED_CHARACTERIZATION_RE.test(queryText)) return null
  // Characterization by politics keeps the coverage-note posture
  // even when the rest of the question decomposes cleanly: the note
  // and the clarification stay, and standalone research remains the
  // fallback whose failure produces the note.
  if (politicsCoverageNote(queryText)) return null
  if (researchFirstCriteria(queryText).length === 0) return null
  const handedOff = { ...intent, clarificationNeeded: false }
  handedOffIntents.add(handedOff)
  return handedOff
}

/**
 * Whether an intent is a research-first handoff: settled (the
 * clarification flag is clear) yet not runnable by canRun, carrying
 * no Census content. See researchFirstHandoff for why that state
 * has exactly one producer.
 */
export function isResearchFirstHandoff(intent: ValidatedIntent): boolean {
  if (handedOffIntents.has(intent)) return true
  return (
    !intent.clarificationNeeded &&
    !canRun(intent) &&
    intent.metricKeys.length === 0 &&
    intent.filters.length === 0
  )
}

/**
 * Starting points offered under the welcome. Each one is a shape the
 * intent path is verified to run — a two-place rent comparison (the
 * first was exercised live against the portal), a single-place lookup,
 * a bounded sweep, and a rent-burden comparison — over the displayable
 * housing figures. No example promises a verdict about a place; each
 * asks for figures the reader then weighs themselves.
 */
export const EXAMPLE_PROMPTS: readonly string[] = [
  'Compare rent in Honolulu and Hilo',
  'What is the median home value in Austin, Texas?',
  'Show me places in Colorado where rent is under $1,500 a month',
  'Compare rent burden in Portland and Seattle',
]

export const PROXY_ERROR_COPY: Record<ProxyError, string> = {
  not_allowlisted:
    'That request is not on the approved list, so it cannot be sent. You can still search, filter, and read every figure by hand below.',
  shape_invalid:
    'That request was not in the expected form, so nothing was sent. You can still search, filter, and read every figure by hand below.',
  rate_limited:
    'Too many requests were sent in a short time, so this one has to wait. You can still search, filter, and read every figure by hand below.',
  credits_exhausted:
    'The shared allowance for the helper is used up for now. You can still search, filter, and read every figure by hand below, with the same figures.',
  provider_down:
    'The wording helper is not responding right now. You can still search, filter, and read every figure by hand below, with the same figures.',
  bad_key:
    'The wording helper could not sign in, so it cannot help right now. You can still search, filter, and read every figure by hand below, with the same figures.',
  budget_exhausted:
    'The shared spending limit for the helper has been reached, so it is off for now. You can still search, filter, and read every figure by hand below, with the same figures.',
  breaker_open:
    'The wording helper has been paused after repeated problems. You can still search, filter, and read every figure by hand below, with the same figures.',
}

/**
 * Clarification candidates for the question currently on screen.
 *
 * Provenance rule (owner live failure, 2026-11-02): the panel listed
 * Hilo, HI and East Honolulu, HI for "What's the cheapest place to
 * live" — places from the reader's standing selection, passed in by
 * App, that the current question never named. A clarification's
 * candidates belong to the CURRENT question's parse and to nothing
 * else: the parse's own geographies (which the panel presents as the
 * choices already made, beside the measure picks) and the universal
 * measure list. No caller-supplied geography list is forwarded — a
 * list built from earlier state (the selection, a previous question)
 * is stale by construction, and when the current parse names no
 * places the candidate list is honestly empty and the panel shows
 * its no-candidates state.
 */
export function clarificationCandidatesFor(
  intent: ValidatedIntent,
  metricKeys: readonly string[] = [],
): ClarificationCandidates {
  return { geographies: [...intent.geographies], metricKeys: [...metricKeys] }
}

export function manualFallbackNote(): string {
  return 'Manual search is fully available: you can pick places and measures, set filters, and read every figure with its source — the same figures the helper would use.'
}

/** Copy for a proxy error class, or null when no error is present. */
export function proxyErrorNote(error: ProxyError | null | undefined): string | null {
  if (!error) return null
  return PROXY_ERROR_COPY[error]
}

function isProxyError(value: unknown): value is ProxyError {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROXY_ERROR_COPY, value)
  )
}

function extractProxyError(e: unknown): ProxyError | null {
  if (typeof e === 'object' && e !== null) {
    const rec = e as Record<string, unknown>
    if (isProxyError(rec.code)) return rec.code
    if (isProxyError(rec.error)) return rec.error
  }
  return null
}

/**
 * Failures worth waiting out (2026-11-01, owner-reported): the shared
 * helper's upstream flaps in minute-scale windows and its circuit
 * breaker pauses for ~30 s, so a single attempt fails a reader whose
 * question would have parsed seconds later. The delays below span a
 * full breaker cooldown; anything else (a bad key, an exhausted
 * budget, a shape refusal) will not heal by waiting and fails at once.
 */
const PARSE_RETRYABLE: ReadonlySet<ProxyError> = new Set([
  'breaker_open',
  'provider_down',
  'rate_limited',
])
const PARSE_RETRY_DELAYS_MS: readonly number[] = [5000, 12000, 25000]

export function Disclosure() {
  return (
    <p role="note" className="house-disclosure">
      {DISCLOSURE_TEXT}
    </p>
  )
}

/**
 * Ask panel. Text is the primary path; mic (Item 12) is an equal main
 * input beside it — consent-gated in MicInput. A final transcript
 * takes the same path as typed text and runs the same way (auto-run,
 * 2026-11-01; atomic voice submission, 2026-11-02 — no confidence
 * gate and no review step in front of the run); the guards are the
 * spoken-number check in accept() and the editable text the words
 * land in. BYO recovery is wired here as the byoProvider retry call
 * path only — no ByoOffer mounts on this surface (owner ruling F-E:
 * zero key/setup content in the judged flow, exhausted states
 * included).
 *
 * Union hand-merge (Panel B1): the CivicScope panel (diagnostics
 * counters, execution note, ExplainAction wiring) carries the Entire
 * tree's mic path and spoken-number gate.
 *
 * No key/setup surface mounts here (owner ruling F-E, 2026-11-02:
 * the judges do not add their own keys, so the judged flow renders
 * zero setup content). The AgentHandoff setup surface moved to the
 * Methodology view — its only remaining mount — where the BYO-key
 * capability stays reachable outside the judged path. The BYO
 * recovery retry above is a call path, not a setup surface, and
 * stays.
 */
export function AskPanel({
  provider,
  byoProvider,
  validator = hermeticStubValidator,
  onExecute,
  onAnswerRequest,
  onGeneralRequest,
  onAskStart,
  onVoiceModeChange,
  proxyError,
  clarificationCandidates,
  figures,
  explanation,
  micRecorder,
  micRecognizer,
  micStorage,
  parseRetryDelaysMs = PARSE_RETRY_DELAYS_MS,
  session: sessionProp,
}: {
  provider: MuseProvider
  /**
   * The session store this panel reads and writes (drive item 17):
   * App creates one above the tab surfaces and passes it in, so the
   * panel's state — and its in-flight runs — survive the panel being
   * unmounted by a tab switch. Absent (standalone mounts, tests), the
   * panel creates an equivalent store of its own; behavior inside
   * the panel is identical either way.
   */
  session?: AskSessionStore
  /**
   * Meta-direct provider for the BYO retry after shared shutoff. Never the
   * metered proxy — a BYO-direct call bypasses the shared allowance
   * entirely, so the proxy meter is untouched. Absent by default.
   */
  byoProvider?: MuseProvider
  validator?: Validator
  /**
   * Runs the intent. May return a sentence for the reader: a mode can be
   * validated and still land on a surface that cannot express one of its
   * bounds, and saying so is better than changing nothing in silence.
   * The sentence may arrive as a promise: the App's execution resolves
   * geographies through indexes that may still be loading when the
   * reader asks, and a verdict taken before they land is the false
   * "nothing was opened" note the views-layer coherence fix removed
   * (P2b confirmation re-run, 2026-11-02). Synchronous returns keep
   * their synchronous timing; a promised sentence lands when it
   * resolves, guarded by the execution run below so a superseded
   * execution never overwrites a newer run's note.
   */
  onExecute?: (intent: ValidatedIntent) => string | void | Promise<string | void>
  /**
   * Hands a runnable, answer-eligible intent and the reader's original
   * question text to the answer layer (App owns the rows and the place
   * index the pipeline screens over). When this is provided, the
   * pipeline owns research for eligible questions — it researches the
   * screened subset with this same question text — so the panel defers
   * its standalone research until the parse settles and fires it only
   * for questions the pipeline will not serve. Absent (tests, other
   * mounts), research fires in parallel with the parse, as before.
   */
  onAnswerRequest?: (intent: ValidatedIntent, queryText: string) => void
  /**
   * Hands a genuinely off-domain intent (plan C13: domain
   * 'off_domain' after the deterministic guards) and the reader's
   * question text to the general lane (App owns the general runner
   * and its rendering in the answer column). Absent, an off-domain
   * parse keeps the pre-lane behavior — the clarification panel —
   * exactly as in mounts without the lane wired.
   */
  onGeneralRequest?: (intent: ValidatedIntent, queryText: string) => void
  /**
   * A new ask has begun (ask-surface reset cure, 2026-11-02): fired
   * once per runQuery, before the parse, so the owner of the answer
   * column can clear the previous run's surface state at ask time —
   * not at hand-off time, which left the previous answer, its modal,
   * and its general card standing through the whole new parse. The
   * inquiry wave-off is not an ask and never fires this. The second
   * argument is the ask's origin fact (Lane A8): 'voice' exactly
   * when this runQuery carries an accepted mic transcript, 'typed'
   * for every other vector (typed submit, example chips) — runQuery
   * is the single funnel every run-start vector passes through, so
   * the fact is exact here and nowhere else. App stamps it onto the
   * answer request this ask mints; continuations of the ask
   * (clarification picks, editor commits — committed picks on the
   * SAME ask, below) inherit it untouched.
   */
  onAskStart?: (queryText: string, origin: AnswerRequestOrigin) => void
  /**
   * Voice-mode activation for spoken answers (plan C10): called with
   * true only when a mic transcript is ACCEPTED (the question arrived
   * by voice), and with false on a typed submit. A clarified
   * transcript does not activate voice mode — no question ran. This
   * ambient signal keeps its remaining jobs (the speech driver's
   * activation for the modal-question and general-inquiry speech
   * acts, and the Stop voice control's rendering); since Lane A8 it
   * no longer gates answer summaries — the request's origin stamp
   * (onAskStart above) does.
   */
  onVoiceModeChange?: (active: boolean) => void
  proxyError?: ProxyError | null
  clarificationCandidates?: ClarificationCandidates
  figures?: readonly FigureInput[]
  explanation?: ExplanationState
  /** Test/port injection for the mic recorder; defaults to the browser recorder. */
  micRecorder?: MicRecorder | null
  /** Test/port injection for the mic recognizer; takes precedence over micRecorder. */
  micRecognizer?: MicRecognizer | null
  /** Test/port injection for mic consent storage; defaults to browser storage. */
  micStorage?: MicStorage
  /** Wait-out schedule for retryable parse failures; tests inject ~0. */
  parseRetryDelaysMs?: readonly number[]
}) {
  /*
   * Session state (drive item 17): every field that used to live in
   * useState/useRef here — the question text, the ack, the understood
   * request, the notes, the busy flag, the standalone research, and
   * the run counters in session.counters (research/execution
   * supersession, the ack rotation, the last question text) — now
   * lives in the session store, which App owns above the tab
   * surfaces. The setters below write through to the store, so a run
   * in flight when the reader switches tabs keeps writing into the
   * session and its result is on screen when they return; nothing
   * about navigation cancels or restarts it. The conversational
   * frame's ack discipline is unchanged (plan C6): the opener
   * rotates by question hash and never repeats the session's
   * previous opener back-to-back; a research question gets the
   * research variant naming its first criterion.
   */
  const localStoreRef = useRef<AskSessionStore | null>(null)
  if (localStoreRef.current === null) localStoreRef.current = new AskSessionStore()
  const session = sessionProp ?? localStoreRef.current
  // The third argument is the server snapshot: several surface pins
  // render this panel with renderToStaticMarkup, and
  // useSyncExternalStore throws there without one. The store is
  // client session state, so the current snapshot IS the server
  // snapshot — a static render reads whatever the session holds.
  const getPanelSnapshot = () => session.getSnapshot().panel
  const panel = useSyncExternalStore(session.subscribe, getPanelSnapshot, getPanelSnapshot)
  const getAnswerSnapshot = () => session.getSnapshot().answer
  const answerSlice = useSyncExternalStore(session.subscribe, getAnswerSnapshot, getAnswerSnapshot)
  const getStageSnapshot = () => session.getSnapshot().stage
  const stage = useSyncExternalStore(session.subscribe, getStageSnapshot, getStageSnapshot)
  const text = panel.text
  const setText = (value: string) => session.setPanel({ text: value })
  const ack = panel.ack
  const setAck = (value: string) => session.setPanel({ ack: value })
  const intent = panel.intent
  const setIntent = (value: ValidatedIntent | null) => session.setPanel({ intent: value })
  const note = panel.note
  const setNote = (value: string) => session.setPanel({ note: value })
  const busy = panel.busy
  const setBusy = (value: boolean) => session.setPanel({ busy: value })
  const caughtError = panel.caughtError
  const setCaughtError = (value: ProxyError | null) => session.setPanel({ caughtError: value })
  const executionNote = panel.executionNote
  const setExecutionNote = (value: string) => session.setPanel({ executionNote: value })
  const coverageNote = panel.coverageNote
  const setCoverageNote = (value: string) => session.setPanel({ coverageNote: value })
  const research = panel.research
  const setResearch = (value: PanelResearchState) => session.setPanel({ research: value })
  /**
   * Single frame ownership (indicator lifecycle cure, 2026-11-02):
   * once the answer layer has adopted THIS run — a request object
   * minted after this run began (identity differs from the request
   * current at run start), for this run's question — the answer
   * area owns the working frame and this panel's mount stands down,
   * so the parse→compose hand-off never renders two ack lines, two
   * dot sets, or two live regions at once. Identity rather than
   * text alone keeps a re-asked identical question's parse frame
   * alive until its own hand-off lands (the runQuery finally's
   * stage-ownership test uses the text half of the same test).
   */
  const adoptedRequest = answerSlice.request
  const frameAdoptedByAnswerLayer =
    adoptedRequest !== null &&
    adoptedRequest !== session.counters.requestAtRunStart &&
    adoptedRequest.queryText === session.counters.lastQueryText

  /**
   * Grounded web findings for the parts of a question the Census data
   * cannot serve (see needsResearch). Fired in parallel with the parse;
   * lands when it lands. A failure — or a reply with no sources — ends
   * in the unavailable state, and for a politics question the coverage
   * note takes over as the honest fallback.
   */
  function startResearch(queryText: string) {
    const run = ++session.counters.researchRun
    // The staged status names this stage while it runs standalone
    // (item 17): the subject is the first decomposed criterion's
    // label, from the reader's own words. When the answer pipeline
    // owns the run instead, the pipeline's own research site names
    // the stage and this path never fires.
    const stageToken = session.stageToken()
    if (stageToken !== null) {
      session.setStage(
        stageToken,
        'researching',
        decomposeResearchCriteria(queryText)[0]?.label ?? null,
      )
    }
    setResearch({ status: 'loading' })
    const signal = new AbortController().signal
    const attempt = async (): Promise<ResearchResult> => {
      try {
        return await provider.research({ queryText }, signal)
      } catch (e) {
        if (byoProvider && hasMetaKey()) {
          return byoProvider.research({ queryText }, signal)
        }
        throw e
      }
    }
    void attempt().then(
      (result) => {
        if (session.counters.researchRun !== run) return
        // Standalone-research narration corner (Lane completion
        // K9): the stored prose renders verbatim in the "From the
        // web" section below, so a line of the model's working
        // narration could head it raw — the helper applies
        // compose's narration filter to the standalone surface.
        // A return that is all narration stores as unavailable:
        // there is no finding to show.
        const prose = result.prose
          ? filterStandaloneResearchProse(result.prose, result.sources)
          : ''
        if (prose && result.sources.length > 0) {
          setResearch({ status: 'done', prose, sources: result.sources })
          setCoverageNote('')
        } else {
          setResearch({ status: 'unavailable' })
          setCoverageNote(politicsCoverageNote(queryText))
        }
        // The standalone research was this run's last outstanding
        // piece: the stage display ends with it. Token-guarded, so a
        // newer question's stage is never cleared by this settle.
        if (stageToken !== null) session.clearStage(stageToken)
      },
      () => {
        if (session.counters.researchRun !== run) return
        setResearch({ status: 'unavailable' })
        setCoverageNote(politicsCoverageNote(queryText))
        if (stageToken !== null) session.clearStage(stageToken)
      },
    )
  }

  const errorNote = proxyErrorNote(proxyError) ?? note

  /**
   * Auto-run (owner directive, 2026-11-01): a request that can run,
   * runs — on submit, on a chip, on an accepted transcript, on a
   * clarification pick, and on a committed editor change. The reader
   * never has to press a Run button; the understood request stays on
   * screen so what ran is always visible and adjustable.
   */
  function executeNow(next: ValidatedIntent, queryText?: string) {
    // A placeless research-first handoff has no view for onExecute
    // to open — its only output would be a "nothing was opened" note
    // contradicting the answer the layer is composing — so it goes
    // to the answer layer alone. A placed handoff still opens its
    // geography in the views, like any lookup.
    const placelessHandoff = isResearchFirstHandoff(next) && next.geographies.length === 0
    if (onExecute && !placelessHandoff) {
      const run = ++session.counters.executionRun
      const said = onExecute(next)
      if (typeof said === 'string') {
        setExecutionNote(said)
      } else if (said && typeof (said as Promise<string | void>).then === 'function') {
        // A promised sentence: clear the previous run's note now (a
        // stale "nothing was opened" must not stand while this run
        // is still resolving), then land this run's sentence only if
        // no newer execution has superseded it. A rejected execution
        // leaves the cleared note — the executed views and the
        // answer area state their own outcomes, as they do for a
        // synchronous void return.
        setExecutionNote('')
        void (said as Promise<string | void>).then(
          (landed) => {
            if (session.counters.executionRun === run && typeof landed === 'string') setExecutionNote(landed)
          },
          () => {},
        )
      } else {
        setExecutionNote('')
      }
    }
    const questionText = queryText ?? (session.counters.lastQueryText || undefined)
    if (onAnswerRequest && questionText && answerEligible(next)) {
      onAnswerRequest(next, questionText)
    }
  }

  /**
   * Returns the parsed intent when one was set (runnable or awaiting
   * clarification), or null when the reply was refused outright.
   * runQuery uses the distinction to settle the deferred research:
   * only a runnable, answer-eligible intent hands research to the
   * answer pipeline.
   */
  function accept(
    result: IntentResult,
    spokenTranscript?: string,
    queryText?: string,
  ): ValidatedIntent | null {
    const check = validateIntent(result.intent)
    // National-screen rescue: a placeless superlative ("cheapest rent in
    // America") clarifies with neither a place nor a measure, and the
    // clarification's only forward path was adding a place — which
    // defeats the question. When the reader's own words carry the
    // reading deterministically, present the country-wide screen as the
    // understood request instead; the note below discloses the reading
    // before anything runs. See core/ai/national-screen.ts. The rescue
    // reads only the reader's words, so it also covers a reply whose
    // shape failed validation — a malformed reply cannot widen it.
    let parsed: ValidatedIntent
    let rescued: ValidatedIntent | null = null
    if (!check.ok) {
      // Count the class only. The model's output and the reader's words are
      // deliberately not recorded anywhere.
      diagnostics.recordIntentFailure('schema_invalid')
      rescued = rescueNationalScreen(
        {
          mode: 'lookup',
          geographies: [],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
        queryText,
      )
      if (!rescued) {
        setNote('That request cannot be run as asked. Try the manual search below.')
        return null
      }
      parsed = rescued
    } else {
      // One answer: the flag is stamped by its single owner, so the gate
      // below and ExplainOnAsk read the same runnability.
      parsed = withRunnability(check.intent)
      // Parse grounding (K1b): a clarifying reply's geographies are
      // the reader's own named places or they do not settle — see
      // dropUngroundedGeographies. Runs before the rescue and the
      // handoff so no downstream path can carry a foreign place.
      parsed = dropUngroundedGeographies(parsed, queryText)
      rescued = rescueNationalScreen(parsed, queryText)
      if (rescued) parsed = rescued
    }
    // Research-first handoff: a parse that settled into clarification
    // but is research-first servable (researchFirstHandoff above)
    // goes to the Answer Layer instead of the clarification panel.
    // Only with an answer layer wired — without one there is no
    // pipeline to hand to, and the panel plus standalone research
    // remain the result, as in the pre-answer-layer mounts. The
    // national-screen rescue runs first and keeps its precedence: a
    // question it can screen deterministically is screened, not
    // researched.
    // Parsed-intent completion (P3 step 6): a parse that declares a
    // bounded sweep serves on the default measure whatever language
    // the question arrived in — the lexical rescue above is additive
    // only and its silence here is not a veto. Runs before the
    // handoff so a declared screen is screened, not researched.
    if (!rescued && parsed.clarificationNeeded) {
      const completed = completeParsedBoundedScreen(parsed)
      if (completed) {
        parsed = completed
        rescued = completed
      }
    }
    let handedOff: ValidatedIntent | null = null
    if (!rescued && parsed.clarificationNeeded && onAnswerRequest) {
      handedOff = researchFirstHandoff(parsed, queryText)
      if (handedOff) parsed = handedOff
    }
    // Spoken-number reconciliation (mic path): a divergence between
    // the numbers heard and the understood request resolves in
    // favour of what was heard, and the run proceeds — the voice
    // path never blocks (atomic ruling, 2026-11-02; cure for the
    // 23:39 live failure, where a numeral-free spoken question
    // dead-ended because this check ran the generated-prose
    // validator over the reader's words and its ranking scan failed
    // the word "best"). Figures the parse introduced or altered come
    // out of the request here; the correction is disclosed with the
    // run's note below and stands in the understood request itself.
    let spokenCorrection = false
    if (spokenTranscript !== undefined) {
      const reconciliation = reconcileSpokenIntent(spokenTranscript, parsed)
      if (reconciliation.dropped.length > 0) {
        parsed = withRunnability(reconciliation.intent)
        spokenCorrection = true
      }
    }
    if (result.prose) {
      const verdict = validator.validate(result.prose, [])
      if (!verdict.pass) {
        diagnostics.recordWithhold(verdict.failure)
        setNote('Wording was withheld for failing verification. Figures are shown without it.')
      }
    }
    // The general lane (plan C13): a parse the guards resolve to
    // genuinely off-domain goes to the general runner, never the
    // clarification panel — the panel was the whole response to
    // every cluster-E case on the baseline build. A hybrid (a place
    // named inside an estimate question) ALSO routes its place part
    // to the data path as a first-class intent, and that data intent
    // is the understood request the panel shows. Without a general
    // lane wired, this branch does not exist and the panel stands.
    const resolution = resolveDomainClassification(parsed, queryText)
    if (resolution.domain === 'off_domain' && onGeneralRequest && queryText) {
      const generalIntent: ValidatedIntent = { ...parsed, domain: 'off_domain' }
      onGeneralRequest(generalIntent, queryText)
      if (resolution.hybrid) {
        const dataIntent = withRunnability(dataIntentForHybrid(parsed))
        setIntent(dataIntent)
        if (canRun(dataIntent)) executeNow(dataIntent, queryText)
      }
      if (spokenCorrection) setNote(SPOKEN_NUMBER_CORRECTION_NOTE)
      return parsed
    }
    setIntent(parsed)
    let flowNote: string | null = null
    if (rescued) {
      const label = NATIONAL_SCREEN_LABELS[rescued.metricKeys[0]!] ?? 'that measure'
      flowNote =
        rescued.geographies.length === 0
          ? `No place was named, so this screens the whole country by ${label}, lowest first. The understood request is below.`
          : `This screens ${rescued.geographies.join(', ')} by ${label}, lowest first. The understood request is below.`
    } else if (handedOff) {
      flowNote =
        'That question is answered from research first: the places the cited findings name are shown with their Census figures in the answer below.'
    } else if (parsed.clarificationNeeded) {
      flowNote = 'More detail is needed before anything runs. Check the understood request below.'
    }
    if (flowNote || spokenCorrection) {
      setNote(
        [flowNote, spokenCorrection ? SPOKEN_NUMBER_CORRECTION_NOTE : null]
          .filter((part): part is string => part !== null)
          .join(' '),
      )
    }
    if (canRun(parsed) || handedOff) executeNow(parsed, queryText)
    return parsed
  }

  /** Editor and clarification changes are committed picks; a runnable result runs. */
  function handleIntentChange(next: ValidatedIntent) {
    setIntent(next)
    if (canRun(next)) executeNow(next)
  }

  /**
   * A parse-held place removed from inside the clarification panel
   * (item-16 cure C3): the panel's choices-already-made are
   * removable there, so correcting the parse never means leaving
   * the panel for the editor above it.
   */
  function handleClarificationRemovePlace(place: string) {
    if (!intent) return
    const result = removeGeography(intent, place)
    if (result.ok) handleIntentChange(result.intent)
  }

  async function runQuery(queryText: string, spokenTranscript?: string) {
    // Single active run (run lockout cure, 2026-11-02): every
    // run-start vector funnels through this function — the form's
    // submit (button and Enter), the example chips, and the mic's
    // final transcript — and the busy flag is the state-layer token
    // they all answer to. The form and the chips disable themselves
    // in the DOM as well, but the voice path calls this function
    // directly, and before this guard a transcript landing mid-parse
    // started a second, concurrent run: a new stage token, an
    // overwritten ack, and two finally blocks racing on the same
    // panel state. A call that arrives while the parse is in flight
    // now starts nothing. (An ask that arrives after the parse —
    // while the previous answer still composes — is a new ask, not
    // a concurrent run: the reset below supersedes the composing
    // run at the answer layer, so exactly one run is ever active.)
    if (session.getSnapshot().panel.busy) return
    // The inquiry wave-off (plan C13 beat 2, battery E9): after the
    // session's one inquiry, a short wave-off reply closes it
    // gracefully — no parse, no second inquiry, no panel. A reply
    // carrying any request content is not a wave-off (the pattern is
    // deliberately narrow) and falls through to the normal pipeline
    // as a first-class request (battery E7).
    if (readInquirySession().asked && isInquiryWaveOff(queryText)) {
      markInquiryWavedOff()
      setAck('')
      setNote(INQUIRY_WAVE_OFF_CLOSE)
      setCoverageNote('')
      setCaughtError(null)
      return
    }
    // New-ask reset (ask-surface reset cure, 2026-11-02): the ask
    // itself — not the hand-off minutes later — is when the previous
    // run's surface state clears. App clears the answer column
    // (previous answer, note, general card, live modal) through
    // onAskStart; this panel's own previous-run state clears with
    // the setters below. The origin fact rides the same call
    // (Lane A8): a spoken transcript is the only voice vector, and
    // it is present exactly on the mic path's runQuery call.
    onAskStart?.(queryText, spokenTranscript !== undefined ? 'voice' : 'typed')
    // The run's stage clock starts at the parse (item 17): the stage
    // state lives in the session store, so it — and the run it
    // describes — continues across any tab switch from here. The
    // finally below ends the stage only when this panel still owns
    // it: a handed-off run's stage is adopted by the answer layer,
    // and a standalone research run's stage ends when research
    // settles (startResearch's completion).
    // Frame ownership baseline (indicator lifecycle cure): the
    // request current as this run begins; a different request
    // object appearing for this question is the answer layer's
    // adoption of THIS run, and the panel's frame stands down.
    session.counters.requestAtRunStart = session.getSnapshot().answer.request
    const stageToken = session.beginStageRun('understanding')
    setBusy(true)
    if (needsResearch(queryText)) {
      const firstCriterion = researchFirstCriteria(queryText)[0] ??
        decomposeResearchCriteria(queryText)[0]
      setAck(
        firstCriterion ? researchAck(firstCriterion.label) : pickAckOpener(queryText, session.counters.lastAckOpener),
      )
    } else {
      const opener = pickAckOpener(queryText, session.counters.lastAckOpener)
      session.counters.lastAckOpener = opener
      setAck(opener)
    }
    setNote('')
    setCoverageNote('')
    setCaughtError(null)
    // The previous run's understood request (its editor, its
    // clarification, its explanation), its execution note, and its
    // web findings are the previous run's surface state: they clear
    // with the ask, so nothing from an earlier question renders
    // through this run or beside its answer — and so no pick on a
    // stale understood request can pair it with this question's
    // text. The research counter bump supersedes any standalone
    // research still in flight from the earlier question (its
    // settle checks the counter and discards itself); the deferred
    // research decision below re-arms the state for this question.
    setIntent(null)
    setExecutionNote('')
    session.counters.researchRun += 1
    setResearch({ status: 'idle' })
    session.counters.lastQueryText = queryText
    // Research answers a different part of the question (what the
    // Census data cannot cover). Without an answer layer wired, it
    // runs in parallel with the parse, as it always has. With one,
    // it is deferred until the parse settles: a runnable,
    // answer-eligible intent hands research to the pipeline (which
    // researches the screened subset with this same question text),
    // and firing the standalone path too would spend two research
    // calls on one question and render two overlapping web sections.
    // A research-first handoff out of clarification hands research
    // to the pipeline the same way. Every other outcome — a
    // clarification that stays one, an ineligible mode, a refused or
    // failed parse — settles by firing the standalone path, so its
    // coverage-note fallback is preserved.
    let researchDeferred = false
    if (needsResearch(queryText)) {
      if (onAnswerRequest) {
        researchDeferred = true
      } else {
        startResearch(queryText)
      }
    }
    // A non-research question needs no counterpart branch here: the
    // reset above already superseded and idled the research state
    // for every run, which is what the old else arm did for this
    // case alone.
    const settleResearch = (parsed: ValidatedIntent | null) => {
      if (!researchDeferred) return
      researchDeferred = false
      // A research-first handoff hands research to the pipeline the
      // same way a runnable eligible intent does — the pipeline's
      // research-first stage IS this question's research, and firing
      // the standalone path too would spend two calls on it.
      if (
        parsed &&
        (canRun(parsed) || isResearchFirstHandoff(parsed)) &&
        answerEligible(parsed)
      ) {
        return
      }
      startResearch(queryText)
    }
    const request = {
      slots: { geographyHints: [], metricHints: [] },
      queryText,
      locale: 'en' as const,
    }
    try {
      // Patient retry: retryable failures wait out the flap window
      // (PARSE_RETRYABLE / PARSE_RETRY_DELAYS_MS above) instead of
      // failing the reader's question on the first bad second.
      let accepted = false
      let acceptedParsed: ValidatedIntent | null = null
      let lastErr: unknown
      for (let attempt = 0; attempt <= parseRetryDelaysMs.length && !accepted; attempt++) {
        try {
          acceptedParsed = accept(
            await provider.intent(request, new AbortController().signal),
            spokenTranscript,
            queryText,
          )
          accepted = true
        } catch (err) {
          lastErr = err
          const known = extractProxyError(err)
          // A proxy failure is counted per attempt, even when a retry
          // or the BYO path below recovers: the shared path did fail,
          // and hiding that would understate its error rate.
          diagnostics.recordIntentFailure(known ?? 'unexpected')
          if (
            !known ||
            !PARSE_RETRYABLE.has(known) ||
            attempt === parseRetryDelaysMs.length
          ) {
            break
          }
          setNote('The wording helper is briefly busy. Retrying your question…')
          await new Promise((resolve) => setTimeout(resolve, parseRetryDelaysMs[attempt]))
        }
      }
      if (accepted) {
        settleResearch(acceptedParsed)
        return
      }
      const known = extractProxyError(lastErr)
      diagnostics.recordErrorState(known ?? 'unexpected')
      if (
        known &&
        byoProvider &&
        decideAskPath({
          budgetExhausted: known === 'credits_exhausted' || known === 'budget_exhausted',
          breakerOpen: false,
          hasByoKey: hasMetaKey(),
        }) === 'byo'
      ) {
        try {
          const parsed = accept(
            await byoProvider.intent(request, new AbortController().signal),
            spokenTranscript,
            queryText,
          )
          settleResearch(parsed)
          return
        } catch {
          // BYO-direct also failed; fall through to the shared copy below.
        }
      }
      settleResearch(null)
      if (known) setCaughtError(known)
      setNote(
        known
          ? PROXY_ERROR_COPY[known]
          : 'Ask is unavailable right now. Manual search still works fully.',
      )
    } finally {
      setBusy(false)
      // End this run's stage unless it outlives the parse: a
      // handed-off answer request (the store's current request is
      // this question) keeps the stage for the answer layer, and a
      // standalone research still in flight keeps it until research
      // settles. Token-guarded either way — a newer question's
      // stage is never this finally's to clear.
      const snapshot = session.getSnapshot()
      const handedOff = snapshot.answer.request?.queryText === queryText
      if (!handedOff && snapshot.panel.research.status !== 'loading') {
        session.clearStage(stageToken)
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    onVoiceModeChange?.(false)
    await runQuery(text)
  }

  /**
   * Mic path (atomic submission, owner ruling 2026-11-02). This is
   * called once per utterance, with the FINAL transcript only —
   * interim words arrive through handleInterimTranscript and are
   * never submitted. A non-empty final transcript is the submission:
   * it stands in the editable text box as the question and runs the
   * exact same auto-run intent path as typed text, plus spoken-number
   * validation in accept() — speech gets no execution path of its
   * own, and no review or approval step sits in front of the run.
   * Correction happens after, through the box and the understood-
   * request controls. An empty final transcript submits nothing and
   * lands in the quiet note below; voice mode does not activate —
   * no question ran.
   */
  function handleTranscript(result: TranscribeResult) {
    const assessment = assessTranscript(result)
    setText(assessment.transcript)
    if (assessment.kind === 'clarify') {
      setCaughtError(null)
      setNote(EMPTY_TRANSCRIPT_NOTE)
      return
    }
    onVoiceModeChange?.(true)
    void runQuery(assessment.transcript, assessment.transcript)
  }

  /**
   * Interim voice words, display-only: they stream into the question
   * box as they are heard so the reader watches the question form.
   * Nothing here submits, parses, or activates voice mode — only the
   * final transcript (handleTranscript) does.
   */
  function handleInterimTranscript(transcript: string) {
    setText(transcript)
  }

  /**
   * Clarification state note (plan C6): the research status line that
   * once stacked over a clarification (owner live failure,
   * 2026-11-02) no longer exists — the working state is the ack +
   * thinking indicator alone, and it ends when the parse settles, so
   * a blocked question never shows a working state. The standalone
   * research CALL still fires for clarification questions — its
   * failure is what produces the politics coverage-note fallback the
   * research-panel tests pin; the findings section itself, when
   * research lands, is content rather than a status line and still
   * renders.
   */

  /**
   * Run lockout (owner ruling, 2026-11-02: "when the ask is running,
   * then remove the ask button so it's not tempting to click it
   * again"): a run is in flight from the ask until its terminal —
   * the parse (busy) and every staged phase after it, the stage
   * living until the terminal clears it. For that whole span the
   * Ask button is REMOVED from the DOM (not disabled: no control
   * stands there inviting a second submit) and the example chips
   * disable; the button returns exactly when the run ends.
   */
  const runInFlight = busy || stage !== null

  return (
    <section aria-labelledby="ask-heading">
      {/*
        Hero composition (compacted, owner phone review 2026-11-02): the
        heading is one line at title size, the question box follows
        immediately, and the examples sit BELOW the box in compact form.
        Measured reason: at display size (text-5xl heading + 56px hero
        mark in App + four 44px chips above the box) the pill landed
        below the fold on a 412x915 phone — the reader met decoration
        before the one control the page exists for. The heading text
        stays exactly "Ask CivicScope" — the accent span is presentation
        only, and a test pins the heading.
      */}
      <h2
        id="ask-heading"
        className="text-center text-2xl font-light tracking-tight text-slate-900 sm:text-3xl"
      >
        Ask <span className="font-medium text-[rgb(var(--accent))]">CivicScope</span>
      </h2>
      <form onSubmit={submit} className="mx-auto mt-4 max-w-2xl">
        <label htmlFor="ask-input" className="sr-only">
          Ask in plain language
        </label>
        {/*
          The question box is the page's hero (redesign, 2026-11-01): one
          rounded field with a soft shadow, the way a search box sits on a
          search page — the input is borderless inside it and the Ask
          button is a pill at its right edge. The visible label is
          screen-reader-only. The standing disclosures no longer sit
          under the box (owner rule, 2026-11-02: explain nothing): the
          circled question mark inside the pill opens them on hover or
          tap, verbatim, in a small panel. The raw-text note keeps its
          id and its exact text inside that panel — the input's
          aria-describedby still resolves, and the conformity pin on
          the note's presence still holds.
        */}
        <div className="relative flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pl-5 pr-1.5 shadow-[0_1px_6px_rgba(32,33,36,0.14)] transition-shadow focus-within:shadow-[0_2px_12px_rgba(32,33,36,0.22)] hover:shadow-[0_2px_10px_rgba(32,33,36,0.18)]">
          <input
            id="ask-input"
            aria-describedby="ask-raw-text-note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            placeholder="Ask in plain language"
            className="min-w-0 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-500"
          />
          <HelpTip label="About the wording helper" align="right">
            <p id="ask-raw-text-note" role="note">
              {RAW_TEXT_DISCLOSURE}
            </p>
            <div className="mt-2">
              <Disclosure />
            </div>
            {/* The shared-key fact the first-visit notice card used to
                carry standing on this surface (owner phone review,
                2026-11-02: the card came off every task surface; the
                fact lives here and on Methodology instead). The sentence
                is the tour notice's own, from its single source in
                GuidedTour, so the two cannot drift apart. */}
            <p className="mt-2">{censusLoadSentence()}</p>
          </HelpTip>
          {!runInFlight && (
            <button type="submit" className="btn-primary shrink-0">
              Ask
            </button>
          )}
        </div>
      </form>
      <div className="mt-3 flex justify-center">
        <MicInput
          transcribe={(audio, mimeType) =>
            provider.transcribe({ audio, mimeType }, new AbortController().signal)
          }
          onTranscript={handleTranscript}
          onInterimTranscript={handleInterimTranscript}
          recognizer={micRecognizer}
          recorder={micRecorder}
          storage={micStorage}
        />
      </div>
      {/* No welcome prose (owner rule, 2026-11-02: explain nothing —
          the examples themselves carry the invitation, and each one
          stays inside the intent envelope the app can run, so a tapped
          example succeeds rather than stranding the reader in a
          clarification). Compact form (owner phone review, 2026-11-02):
          below the question box, small type and padding, wrapping in at
          most two rows at phone width — they are shortcuts duplicating
          the typed path, so they sit at 36px rather than the 44px of a
          primary control; the box itself keeps its full-size targets. */}
      <div className="mt-4 flex flex-wrap justify-center gap-1.5" aria-label="Example questions">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            disabled={runInFlight}
            onClick={() => {
              setText(example)
              void runQuery(example)
            }}
            className="min-h-[36px] rounded-full border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            {example}
          </button>
        ))}
      </div>
      {busy && !frameAdoptedByAnswerLayer && (
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-700">
          {/* The ack, plus the visual indicator once the run passes
              one second (item 17; StagedStatus owns the threshold
              and the aria-live discipline). This mount owns the
              frame only until the answer layer adopts the run —
              see frameAdoptedByAnswerLayer above. */}
          <StagedStatus session={session} ack={ack} />
        </p>
      )}
      {errorNote && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-700">
          {errorNote}
        </p>
      )}
      {coverageNote && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          {coverageNote}
        </p>
      )}
      {/*
        One status line at a time (owner screenshot, 2026-11-02: the
        retry note and the web-unavailable note stacked into two
        competing lines). The research outcome lines are sequenced
        behind the parse: while the parse is running, retrying, or
        has failed, its status is the one line shown; the research
        line appears once the parse has settled — and never while
        the settled parse sits in clarification (inClarification
        above): a blocked question is not looking anything up, and
        saying it is was the owner's 2026-11-02 screenshot. (A
        clarification note from a settled parse is content, not a
        competing status, and the politics fallback pairs with the
        research outcome lines by design — see research-panel tests.)
      */}
      {/*
        The standalone research status line that used to render here
        is folded into the ack + thinking indicator (plan C6): one
        working state, not stacked lines. The research CALL and its
        done/unavailable outcomes below are unchanged.
      */}
      {research.status === 'done' && (
        <section aria-label="From the web" className="mt-4 border-t border-slate-200 pt-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-slate-800">From the web</h3>
            <HelpTip label="About web findings">
              Web findings via Muse search, with sources. These are not Census figures; the
              Census figures for this question are computed separately and shown with their
              own sources.
            </HelpTip>
          </div>
          {research.prose.split(/\n\n+/).map((para, i) => (
            <p key={i} className="mt-2 whitespace-pre-line text-base leading-relaxed text-slate-700">
              {para}
            </p>
          ))}
          <ul className="mt-2 list-disc pl-5 text-sm">
            {research.sources.map((s) => (
              <li key={s.url}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#1a73e8] underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {research.status === 'unavailable' && !busy && !caughtError && !proxyError && (
        <p role="note" className="mt-2 text-sm text-slate-600">
          Web findings are unavailable right now. The Census figures for this question still
          work.
        </p>
      )}
      {proxyError && (
        <p className="mt-2 text-sm text-slate-600">{manualFallbackNote()}</p>
      )}
      {/* No ByoOffer mount here — owner ruling F-E (2026-11-02) is
          absolute: zero key/setup content in the judged flow, and the
          offer's own-key text ("If you have your own Meta key, you
          can add it in settings") still rendered on this surface in
          the credits_exhausted / budget_exhausted state (F-E residual,
          found by the P4 re-run on the shipped build). That state now
          shows only the honest exhausted note (PROXY_ERROR_COPY via
          the error line above). The ByoOffer component itself stays:
          no production surface mounts it after this removal (its only
          remaining mounts are its direct component tests in
          ask-completion, which pin its shutoff-only contract), and
          BYO also stays as a call path here — the byoProvider retry
          above is a provider seam, not reader-facing key content.
          No AgentHandoff mount here either — the agent setup surface
          lives on the Methodology view only. */}
      {intent && (
        <>
          {/* One editing surface during clarification (item-16 cure
              C3): while the panel is mounted it owns additions, and
              the editor above it keeps only its removal chips. */}
          <IntentEditor
            intent={intent}
            onChange={handleIntentChange}
            suppressAddForms={!canRun(intent) && !isResearchFirstHandoff(intent)}
          />
          {!canRun(intent) && !isResearchFirstHandoff(intent) ? (
            <ClarificationPanel
              intent={intent}
              candidates={clarificationCandidatesFor(
                intent,
                clarificationCandidates?.metricKeys ?? [],
              )}
              onResolve={handleIntentChange}
              onRemovePlace={handleClarificationRemovePlace}
            />
          ) : (
            <>
              {executionNote && (
                <p role="status" className="mt-2 text-sm text-slate-700">
                  {executionNote}
                </p>
              )}
              <ExplainOnAsk
                intent={intent}
                figures={figures}
                explanation={explanation}
                provider={provider}
              />
            </>
          )}
        </>
      )}
      {/* The figures/wording disclosure used to close the panel as a
          standing paragraph; it now lives in the question box's help
          panel above (owner rule, 2026-11-02: explain nothing). */}
    </section>
  )
}
