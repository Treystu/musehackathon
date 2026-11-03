/**
 * Spoken-answer composer (conversational stack C10, branch b).
 *
 * Roster re-verification, 2026-11-02: the Meta Model API has no
 * text-to-speech model. Its only voice model, muse-voice-transcribe-1.0,
 * is speech-to-text (audio in, text out). Voice-out therefore uses the
 * device's speech synthesis (speech-driver.ts), and the copy boundary
 * is pinned in code and in tests/ai/voice-copy-boundary.test.ts: the
 * intelligence is Muse; the voice is the device's. Nothing in this
 * module may claim or imply the voice itself is a Muse model.
 *
 * Composition rules (plan C10 + detail annex, exact):
 *   - The spoken layer is built ONLY from the composed answer's
 *     verified parts: the headline sentence, then one sentence per
 *     criterion of the form "<criterion>: <outcome words>".
 *   - A figure may be spoken only when it is in the verified figure
 *     list the caller passes in, BY REFERENCE: the composer looks a
 *     criterion's figure up in that list and copies its value; it
 *     never reads a numeral out of prose.
 *   - A final guard scans every composed sentence for numerals
 *     (digits and number words). Any sentence containing a numeral
 *     that is not in the verified set is DROPPED whole -- never
 *     approximated, never rephrased around a guessed value. This is
 *     the spoken-number provenance pattern of src/core/ai/mic.ts,
 *     applied to output: an unverified numeral cannot reach speech.
 *   - Only a 'verified' answer speaks at all. A withheld, blocked, or
 *     empty answer produces no sentences: speech never replaces the
 *     on-screen card, and an unverified answer has no spoken form.
 *
 * Lane A8 extension (owner directive, 2026-11-03 02:57 HST): the
 * verified-only rule above is the C10 core; the classes below extend
 * speech to every terminal class with class-specific honesty, under
 * a modality gate that lives in the session store (the request's
 * origin stamp — planTerminalSpeech here is its pure planner):
 *   - Speech composes off the LANDED terminal only, at most 6
 *     sentences: an expectation-contrast hook (only when the
 *     contrast is structurally grounded in the answer's own data),
 *     the headline/conclusion, up to 3 criterion sentences in
 *     priority order with figures by reference, one chart-reference
 *     sentence naming exactly the charts the terminal render
 *     mounted (terminalChartKinds, result-scale.ts — one shared
 *     derivation), and a class status line where the class defines
 *     one.
 *   - Every composed sentence passes (i) the numeral guard with the
 *     composition's verified set, (ii) the criteria-grounded
 *     banned-construction sentence filter, and (iii) the full
 *     generated-prose validator over the joined prose — behind a
 *     shed-in-order ladder: full candidate, then without the hook,
 *     then the core set, then silence. The validator is never
 *     loosened. Honest notes take no ladder: the note's own text
 *     through (i) + (iii), all-or-nothing — failure is silence,
 *     never a paraphrase.
 *   - Calibration exception, measured 2026-11-03 on the real
 *     validator and recorded in the lane RESULTS: validate()'s
 *     small-count suppression classifies figures by key-naming
 *     convention and suppresses any count-keyed figure under 20, so
 *     a traceable stated count (the hook's "8 places ahead of it")
 *     fails validate() as an invented numeral under every honest
 *     key — while passing checkNumeralProvenance, the validator
 *     module's own provenance instrument for figures that are
 *     provenance by definition. The hook sentence is therefore
 *     judged by checkNumeralProvenance (with its stated count in
 *     the figure set) + (i) + (ii); every other sentence is judged
 *     by all three rungs including validate(). An untraceable count
 *     is never composed in the first place.
 *   - Spoken figures carry no margins of error (SpokenVerifiedFigure
 *     has no margin field), so the validator's precision step has
 *     no MOE input on this path — measured in the same calibration:
 *     citing a wide-margin figure WITH its margin in the set fails
 *     validate() on precision. The card carries the margins; speech
 *     copies the figures.
 *   - A researched criterion whose lookup DID NOT RETURN is spoken
 *     as such ("the lookup did not return"), never with the
 *     structural wording ("not measurable from available sources")
 *     — the two outcomes are different facts about the run.
 *   - Withheld / blocked stay silent. Speech never replaces or
 *     softens a refusal, and nothing is spoken from interim or
 *     progressive state: this module reads landed terminals only.
 */
import {
  claimMentionsPlace,
  filterBannedSentences,
  type AnswerPlace,
  type ComposedAnswer,
  type CriterionEvidence,
  type CriterionEvidenceStatus,
} from '../../core/ai/answer'
import { EVIDENCE_CLASS_LABELS } from '../../core/ai/flexible'
import { GENERAL_SPOKEN_CLASS_LINE } from '../../core/ai/general'
import {
  orderedResultPlaces,
  terminalChartKinds,
} from '../../core/map/result-scale'
import {
  checkNumeralProvenance,
  createValidator,
  type FigureForValidation,
} from '../../core/ai/validator'
import type { AnswerRequestOrigin } from './session-store'

/**
 * The exact Methodology sentence for branch (b), the branch the
 * 2026-11-02 roster re-verification proved real. DRAFT for the
 * integration ship: the coordinator places this sentence verbatim in
 * Methodology in the same ship that wires the driver, so the claim
 * lands with the behaviour it describes (plan invariant 5).
 */
export const METHODOLOGY_VOICE_SENTENCE =
  "The intelligence is Muse; the voice is the device's."

/** A verified figure the composer may speak, carried by reference. */
export interface SpokenVerifiedFigure {
  key: string
  value: number
}

/**
 * The verified figure list for an answer, derived from the figures on
 * its places -- the same figures deterministic verify checked against
 * the screened rows. Callers may pass their own list to
 * composeSpokenSummary; this helper is the by-reference derivation the
 * integration wiring uses.
 */
export function verifiedFiguresFromAnswer(
  answer: ComposedAnswer,
): SpokenVerifiedFigure[] {
  const figures: SpokenVerifiedFigure[] = []
  for (const place of answer.places) {
    for (const figure of place.figures) {
      figures.push({ key: figure.key, value: figure.value })
    }
  }
  return figures
}

/* ------------------------------------------------------------------ */
/* Numeral guard                                                       */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
}

interface FoundNumeral {
  value: number
  decimals: number
}

function scanNumerals(sentence: string): FoundNumeral[] {
  const found: FoundNumeral[] = []
  for (const match of sentence.matchAll(
    /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g,
  )) {
    const raw = match[0].replace(/,/g, '')
    const dot = raw.indexOf('.')
    found.push({
      value: Number(raw),
      decimals: dot >= 0 ? raw.length - dot - 1 : 0,
    })
  }
  // Number words, with hundred/thousand scales folded the same way
  // the validator folds them, so "one thousand two hundred" is one
  // numeral (1200), not three small ones that might each pass.
  const words = sentence.toLowerCase().match(/[a-z]+/g) ?? []
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (!(word in NUMBER_WORDS) && word !== 'hundred' && word !== 'thousand') {
      i++
      continue
    }
    let value = 0
    let group = 0
    let consumed = false
    while (i < words.length) {
      const w = words[i] as string
      if (w in NUMBER_WORDS) {
        group += NUMBER_WORDS[w] as number
        consumed = true
        i++
      } else if (w === 'hundred') {
        group = (group || 1) * 100
        consumed = true
        i++
      } else if (w === 'thousand') {
        value += (group || 1) * 1000
        group = 0
        consumed = true
        i++
      } else if (w === 'and' && consumed) {
        i++
      } else {
        break
      }
    }
    if (consumed) found.push({ value: value + group, decimals: 0 })
  }
  return found
}

function isVerifiedNumeral(
  found: FoundNumeral,
  verifiedValues: readonly number[],
): boolean {
  // The tolerance is the validator's displayed-rounding tolerance:
  // a spoken rendering may round a verified figure to the precision
  // it speaks at, but may never land on a different figure.
  const tolerance = 0.5 * 10 ** -found.decimals
  return verifiedValues.some(
    (value) => Math.abs(value - found.value) <= tolerance,
  )
}

/**
 * The final provenance guard: keep only sentences whose every numeral
 * is in the verified set. Exported so the integration wiring (and its
 * tests) can run the same guard over any sentence the voice UI adds
 * later -- modal questions included -- before it reaches the queue.
 */
export function guardSpokenSentences(
  sentences: readonly string[],
  verifiedFigures: readonly SpokenVerifiedFigure[],
): string[] {
  const verifiedValues = verifiedFigures.map((f) => f.value)
  return sentences.filter((sentence) =>
    scanNumerals(sentence).every((found) =>
      isVerifiedNumeral(found, verifiedValues),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

const OUTCOME_WORDS: Readonly<Record<CriterionEvidenceStatus, string>> = {
  met: 'measured',
  partially_measured: 'partially measured',
  not_measurable: 'not measurable from available sources',
}

/** The spoken sentence budget: no spoken summary exceeds this. */
export const SPOKEN_SENTENCE_BUDGET = 6

/** Criterion sentences are capped below the budget (contract order). */
const SPOKEN_CRITERION_CAP = 3

function spokenCriterionLabel(criterion: string): string {
  // Census criteria arrive as metric keys (median_gross_rent); the
  // spoken form is the same words without the underscores. Researched
  // criteria already arrive as reader-facing labels and pass through.
  return criterion.replace(/_/g, ' ')
}

function formatSpokenFigure(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value)
}

/** Split composed prose into its sentences, keeping terminal punctuation. */
function splitSentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/* ---------------- general-lane headline speech ------------------- */

/**
 * The general lane's spoken headline (Lane completion K6, closing
 * the A8 recorded boundary on this class). A general terminal's
 * text shipped through its own validation ladder — the arithmetic
 * check and the Jev accuracy/relevance loop in general-runner —
 * but its numerals are the model's estimates, not verified
 * figures, so the A8 rule stood: beat 1 never speaks, and a voice
 * listener heard only the beat-2 inquiry, a follow-up question
 * whose answer they never heard. The shape that keeps the
 * provenance gate intact: speak ONLY (1) the derivation class in
 * plain words, a code-composed figure-free line; (2) the
 * terminal's precision-limit clause verbatim when it carries one
 * (a code-authored constant, present exactly when the shipped
 * version is below bar — the confidence signal speech owes the
 * listener); and (3) the shipped text's first sentences that pass
 * guardSpokenSentences with an EMPTY verified list, capped at
 * two — every numeral-bearing sentence, digits or number words,
 * is suppressed by the unchanged guard, so no estimate is ever
 * spoken as a figure. No surviving headline sentence: nothing
 * speaks (the class line alone would be framing without an
 * answer), and the inquiry still speaks as before. The gate is
 * not widened: the verified list stays empty, and this composer
 * adds no figures of its own.
 */
export function composeGeneralSpokenHeadline(general: {
  text: string
  precisionLimit: string | null
}): string[] {
  const headline = guardSpokenSentences(splitSentences(general.text.trim()), []).slice(0, 2)
  if (headline.length === 0) return []
  return [
    GENERAL_SPOKEN_CLASS_LINE,
    ...(general.precisionLimit ? [general.precisionLimit] : []),
    ...headline,
  ]
}

/**
 * Whether a criterion's research lookup did not return — as opposed
 * to returning and finding nothing that speaks to the criterion.
 * Two signals, one pipeline record: the answer's researchFailures
 * labels (stamped from the research stage's failedCriteria), and
 * the evidence entry's own did-not-return detail sentence, which
 * criterionEvidenceFor writes from the same failedCriteria list.
 * Either marks the entry; the spoken layer must never describe
 * this outcome with the structural not-measurable wording.
 */
function isLookupFailedEvidence(
  answer: ComposedAnswer,
  evidence: CriterionEvidence,
): boolean {
  if (evidence.kind !== 'research' || evidence.status !== 'not_measurable') {
    return false
  }
  return (
    (answer.researchFailures ?? []).includes(evidence.criterion) ||
    evidence.detail.startsWith('The research lookup for this criterion did not return')
  )
}

/** The one plain sentence naming the criteria whose lookups did not return. */
function lookupFailureSentence(labels: readonly string[]): string | null {
  if (labels.length === 0) return null
  if (labels.length === 1) {
    return `The research lookup for ${labels[0]} did not return, so that criterion is not measured here.`
  }
  const joined =
    labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
  return `The research lookups for ${joined} did not return, so those criteria are not measured here.`
}

/**
 * Criterion sentences in the contract's priority order: a measured
 * Census criterion carrying a spoken figure first, then measured,
 * then partially measured, then not measurable — each criterion
 * once, in the answer's own order within a tier. Lookup-failed
 * entries are NOT criterion sentences: they group into the one
 * lookup sentence the caller appends (the degraded class's honesty
 * line). Returns the sentences and the failed labels.
 */
function criterionSentences(
  answer: ComposedAnswer,
  verifiedFigures: readonly SpokenVerifiedFigure[],
): { sentences: string[]; lookupFailedLabels: string[] } {
  const failed: CriterionEvidence[] = []
  const tiers: Array<{ tier: number; index: number; sentence: string }> = []
  answer.criterionEvidence.forEach((evidence, index) => {
    if (isLookupFailedEvidence(answer, evidence)) {
      failed.push(evidence)
      return
    }
    const label = spokenCriterionLabel(evidence.criterion)
    const outcome = OUTCOME_WORDS[evidence.status] ?? evidence.status
    let sentence = `${label}: ${outcome}.`
    let tier: number
    if (evidence.kind === 'census' && evidence.status === 'met') {
      const figure = verifiedFigures.find((f) => f.key === evidence.criterion)
      if (figure) {
        const placeName = placeNameForFigure(answer, figure)
        sentence = placeName
          ? `${label}: ${outcome}, ${formatSpokenFigure(figure.value)} for ${placeName}.`
          : `${label}: ${outcome}, ${formatSpokenFigure(figure.value)}.`
        tier = 0
      } else {
        tier = 1
      }
    } else if (evidence.status === 'met') {
      tier = 1
    } else if (evidence.status === 'partially_measured') {
      tier = 2
    } else {
      tier = 3
    }
    tiers.push({ tier, index, sentence })
  })
  // Labels the stage recorded as failed but no evidence entry
  // carries (a stamp/evidence skew) are still accounted, not lost.
  // A label whose entry measured is never named here — the entry's
  // own outcome is the account for that criterion.
  const failedLabels = failed.map((e) => e.criterion)
  for (const label of answer.researchFailures ?? []) {
    if (failedLabels.includes(label)) continue
    const entry = answer.criterionEvidence.find((e) => e.criterion === label)
    if (!entry) failedLabels.push(label)
  }
  tiers.sort((a, b) => a.tier - b.tier || a.index - b.index)
  return { sentences: tiers.map((t) => t.sentence), lookupFailedLabels: failedLabels }
}

/** The place a verified figure belongs to, for the spoken clause. */
function placeNameForFigure(
  answer: ComposedAnswer,
  figure: SpokenVerifiedFigure,
): string | null {
  for (const place of answer.places) {
    const match = place.figures.find(
      (f) => f.key === figure.key && f.value === figure.value,
    )
    if (match) return place.name
  }
  return null
}

/* ------------------------- the hook ------------------------------- */

/**
 * Association markers for hook route (b): a surviving claim marking
 * a place as the commonly associated one, in the claim's own words.
 * The marker set is the design's class — obvious / well-known /
 * commonly / associated with — pinned by fixtures; a claim without
 * one of these markers never grounds a hook.
 */
const ASSOCIATION_MARKER_RE =
  /\b(obvious|well-known|well known|commonly|associated with)\b/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether the question's own words name this place (full name or city part). */
function questionNamesPlace(queryText: string, place: AnswerPlace): boolean {
  const q = queryText.toLowerCase()
  const full = place.name.toLowerCase()
  if (q.includes(full)) return true
  const city = full.split(',')[0]?.trim() ?? ''
  if (city.length < 3) return false
  return new RegExp(`\\b${escapeRegExp(city)}\\b`).test(q)
}

interface HookComposition {
  sentence: string
  /** The stated count, traceable to the answer's place ordering. */
  count: SpokenVerifiedFigure
}

/**
 * The expectation-contrast hook, composed only when the contrast is
 * structurally grounded in the answer's own data:
 *   (a) the question named a place that appears in the answer's
 *       assessed set, or (b) a surviving claim marks a place as the
 *       commonly associated one (ASSOCIATION_MARKER_RE);
 *   the answer's own ordering (the card's display order) puts at
 *   least one other place above that expected place; and the count
 *   of places above it is exactly its index in that ordering — a
 *   stated count traceable to an answer field. No grounded expected
 *   place, an expected place that wins, or an untraceable count:
 *   no hook. The owner's illustrative flourish ("that you might
 *   have never heard of") is a claim about the LISTENER and is
 *   never composed; the count and the chart pointer carry the
 *   curiosity instead. Degraded and flexible answers carry no hook
 *   (their classes define none).
 */
function composeHook(
  answer: ComposedAnswer,
  queryText: string | undefined,
): HookComposition | null {
  if (answer.status !== 'verified') return null
  if ((answer.researchFailures ?? []).length > 0) return null
  const ordered = orderedResultPlaces(answer)
  if (ordered.length < 2) return null
  const candidates: AnswerPlace[] = []
  if (queryText) {
    for (const place of ordered) {
      if (questionNamesPlace(queryText, place)) candidates.push(place)
    }
  }
  for (const place of ordered) {
    if (candidates.includes(place)) continue
    const marked =
      place.claims.some((claim) => ASSOCIATION_MARKER_RE.test(claim.text)) ||
      answer.generalClaims.some(
        (claim) =>
          ASSOCIATION_MARKER_RE.test(claim.text) &&
          claimMentionsPlace(claim, place),
      )
    if (marked) candidates.push(place)
  }
  for (const expected of candidates) {
    const above = ordered.indexOf(expected)
    if (above < 1) continue
    return {
      sentence: `You might have expected ${expected.name} — the findings put ${above} ${above === 1 ? 'place' : 'places'} ahead of it.`,
      count: { key: 'stated:places-ahead', value: above },
    }
  }
  return null
}

/* --------------------- chart reference ---------------------------- */

/**
 * The one chart-reference sentence, from the shared derivation
 * (terminalChartKinds): it names exactly the charts the terminal
 * render mounted, in plain words, with the chart's subject in the
 * legend's own words — and carries no figures and no claim beyond
 * presence and subject. No rendered chart: no sentence.
 */
function chartReferenceSentence(answer: ComposedAnswer): string | null {
  const kinds = terminalChartKinds(answer)
  if (kinds.length === 0) return null
  if (kinds.length === 1) {
    const chart = kinds[0]!
    return `The map shows the places by ${chart.subject}.`
  }
  return `The answer includes ${kinds.map((k) => k.spokenName).join(' and ')}.`
}

/* --------------------- candidate assembly ------------------------- */

interface SpokenCandidate {
  hook: string | null
  /**
   * The headline as ONE spoken element: the answer's summary
   * verbatim (a summary may itself carry two sentences — it is
   * never rebuilt or split here; the p3c pins hold spoken[0] ===
   * answer.summary). The budget counts its internal sentences.
   */
  headline: string | null
  headlineSentences: number
  middle: string[]
  chart: string | null
  status: string | null
  statedCounts: SpokenVerifiedFigure[]
}

/**
 * The research-first class's headline: the conclusion. Compose
 * attaches the de-scaffolded synthesis claim to the place it names,
 * in prose order, so on the lead place it is the LAST claim (the
 * "Answer:" segment is the research prose's final segment — measured
 * on the Texas specimen, 2026-11-03). The claim is a headline
 * candidate only when its every numeral is verified; otherwise the
 * class falls back to the answer's summary, and the ladder's guard
 * remains the final word either way.
 */
function researchFirstHeadline(
  answer: ComposedAnswer,
  verifiedFigures: readonly SpokenVerifiedFigure[],
): string | null {
  const lead = answer.places[0]
  const conclusion = lead?.claims[lead.claims.length - 1]?.text?.trim()
  if (conclusion) {
    const kept = guardSpokenSentences([conclusion], verifiedFigures)
    if (kept.length === 1) return conclusion
  }
  const summary = (answer.summary ?? '').trim()
  return summary || null
}

/**
 * The research-first class's status line: the qualifying places,
 * named — the shortlist the card shows, in the answer's own order.
 * Names only: no figure rides this sentence, and no meet claim is
 * made beyond the research naming the summary itself states. Past
 * five names the card is the list; the sentence says so without a
 * numeral.
 */
function shortlistSentence(answer: ComposedAnswer): string | null {
  const names = answer.places.map((p) => p.name)
  if (names.length === 0) return null
  const shown = names.slice(0, 5)
  const list =
    shown.length === 1
      ? shown[0]!
      : shown.length === 2
        ? `${shown[0]} and ${shown[1]}`
        : `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`
  const tail = names.length > shown.length ? ', and more places on the card' : ''
  return `The places named for the stated criteria are ${list}${tail}.`
}

/**
 * The flexible class's verified set: the completion's own figures —
 * the answer-level list and every place's — which verifyFlexibleAnswer
 * checked before the answer landed. Keys are the figures' reader
 * labels; the numeral guard and the validator read values.
 */
function flexibleVerifiedFigures(answer: ComposedAnswer): SpokenVerifiedFigure[] {
  const flexible = answer.flexible
  if (!flexible) return []
  const figures: SpokenVerifiedFigure[] = []
  for (const figure of flexible.figures) {
    figures.push({ key: figure.label, value: figure.value })
  }
  for (const place of flexible.places) {
    for (const figure of place.figures) {
      figures.push({ key: figure.label, value: figure.value })
    }
  }
  return figures
}

/** One flexible place spoken in its evidence-class words. */
function flexiblePlaceSentence(place: {
  name: string
  evidenceClass: keyof typeof EVIDENCE_CLASS_LABELS
}): string {
  const words = EVIDENCE_CLASS_LABELS[place.evidenceClass]
    .replace(' — ', ', ')
    .replace(/^./, (c) => c.toLowerCase())
  return `${place.name}: ${words}.`
}

function buildCandidate(
  answer: ComposedAnswer,
  verifiedFigures: readonly SpokenVerifiedFigure[],
  queryText: string | undefined,
): SpokenCandidate | null {
  if (answer.status === 'flexible') {
    const flexible = answer.flexible
    if (!flexible) return null
    // Headline: the card's deterministic framing line (the summary —
    // it states the match outcome and the labelling rule). Middle:
    // the completion's own conclusion (its prose's first sentence),
    // then its places in evidence-class words. No chart reference
    // (the derivation yields none for this class) and no hook: this
    // evidence class supports neither.
    const middle: string[] = []
    const conclusion = splitSentences(flexible.prose.trim())[0]
    if (conclusion) middle.push(conclusion)
    for (const place of flexible.places) middle.push(flexiblePlaceSentence(place))
    const summary = (answer.summary ?? '').trim()
    const headlineSentences = splitSentences(summary).length
    // The budget binds this class too: the conclusion keeps its
    // slot first, then places in the completion's own order.
    const cappedMiddle = middle.slice(
      0,
      Math.max(0, SPOKEN_SENTENCE_BUDGET - headlineSentences),
    )
    return {
      hook: null,
      headline: summary || null,
      headlineSentences,
      middle: cappedMiddle,
      chart: chartReferenceSentence(answer),
      status: null,
      statedCounts: [],
    }
  }
  if (answer.status !== 'verified') return null

  const { sentences: criteria, lookupFailedLabels } = criterionSentences(
    answer,
    verifiedFigures,
  )
  const degraded = lookupFailedLabels.length > 0
  const hook = degraded ? null : composeHook(answer, queryText)
  const researchFirst = answer.researchNamedPlaces !== undefined
  const headline = researchFirst
    ? researchFirstHeadline(answer, verifiedFigures)
    : (answer.summary ?? '').trim() || null
  const chart = chartReferenceSentence(answer)
  const lookup = lookupFailureSentence(lookupFailedLabels)
  const status = researchFirst ? shortlistSentence(answer) : null

  // Budget: hook + headline + middle + chart + status <= 6, with
  // the middle (criterion sentences, then the lookup sentence last
  // — it is the class's disclosure, ranked after the measured
  // outcomes it qualifies) capped at 3 by the contract and then by
  // whatever the fixed slots leave.
  const fixed =
    (hook ? 1 : 0) +
    splitSentences(headline ?? '').length +
    (chart ? 1 : 0) +
    (status ? 1 : 0)
  const middleCap = Math.max(
    0,
    Math.min(SPOKEN_CRITERION_CAP + (lookup ? 1 : 0), SPOKEN_SENTENCE_BUDGET - fixed),
  )
  const middle = [...criteria, ...(lookup ? [lookup] : [])].slice(0, middleCap)
  // The lookup sentence is the degraded class's honesty line: if
  // the budget squeeze would cut it while keeping a lower-tier
  // criterion sentence, the disclosure outranks the tail criterion.
  if (lookup && !middle.includes(lookup) && middleCap > 0) {
    middle[middle.length - 1] = lookup
  }
  return {
    hook: hook?.sentence ?? null,
    headline,
    headlineSentences: splitSentences(headline ?? '').length,
    middle,
    chart,
    status,
    statedCounts: hook ? [hook.count] : [],
  }
}

/* ------------------------- the ladder ----------------------------- */

const spokenValidator = createValidator()

/**
 * Run one rung of the validation ladder over a sentence set:
 * (i) the numeral guard per sentence (a sentence with an
 * unverifiable numeral is dropped whole), (ii) the criteria-grounded
 * banned-construction filter per sentence, (iii) the full validator
 * over the joined prose against the composition's verified figures.
 * The hook sentence, when present, is judged at (iii) by
 * checkNumeralProvenance with its stated count in the set — the
 * measured calibration exception in the file header — and by (i)
 * and (ii) like every other sentence. Returns the kept sentences,
 * or null when the rung fails as a whole.
 */
function runLadderRung(
  sentences: readonly string[],
  candidate: SpokenCandidate,
  verifiedFigures: readonly SpokenVerifiedFigure[],
): string[] | null {
  if (sentences.length === 0) return null
  const guardSet = [...verifiedFigures, ...candidate.statedCounts]
  const guarded = guardSpokenSentences(sentences, guardSet)
  const kept: string[] = []
  for (const sentence of guarded) {
    if (filterBannedSentences(sentence).dropped.length === 0) kept.push(sentence)
  }
  if (kept.length === 0) return null
  const hookSentence =
    candidate.hook && kept.includes(candidate.hook) ? candidate.hook : null
  const rest = hookSentence ? kept.filter((s) => s !== hookSentence) : kept
  if (rest.length > 0) {
    const figures: FigureForValidation[] = verifiedFigures.map((f) => ({
      key: f.key,
      value: f.value,
    }))
    if (!spokenValidator.validate(rest.join(' '), figures).pass) return null
  }
  if (hookSentence) {
    const figures: FigureForValidation[] = [
      ...verifiedFigures.map((f) => ({ key: f.key, value: f.value })),
      ...candidate.statedCounts.map((f) => ({ key: f.key, value: f.value })),
    ]
    if (!checkNumeralProvenance(hookSentence, figures).pass) return null
  }
  return kept
}

function runLadder(
  candidate: SpokenCandidate,
  verifiedFigures: readonly SpokenVerifiedFigure[],
): string[] {
  const headlineSlot = candidate.headline ? [candidate.headline] : []
  const full: string[] = [
    ...(candidate.hook ? [candidate.hook] : []),
    ...headlineSlot,
    ...candidate.middle,
    ...(candidate.chart ? [candidate.chart] : []),
    ...(candidate.status ? [candidate.status] : []),
  ]
  const withoutHook: string[] = [
    ...headlineSlot,
    ...candidate.middle,
    ...(candidate.chart ? [candidate.chart] : []),
    ...(candidate.status ? [candidate.status] : []),
  ]
  const core: string[] = [
    ...headlineSlot,
    ...candidate.middle,
    ...(candidate.chart ? [candidate.chart] : []),
  ]
  for (const rung of [full, withoutHook, core]) {
    const kept = runLadderRung(rung, candidate, verifiedFigures)
    if (kept) return kept
  }
  return []
}

/* ------------------------- public surface ------------------------- */

/**
 * Compose the spoken summary for a landed answer terminal.
 *
 * Classes: a verified Census card and a research-first card speak
 * the full contract (hook when grounded, headline, prioritized
 * criterion sentences, chart reference, class status line); the
 * degraded screen card (researched criteria whose lookups did not
 * return) speaks its measured parts plus the lookup sentence and no
 * hook; a flexible completion speaks its framing headline, its own
 * conclusion, and its places in evidence-class words, with no chart
 * reference and no hook; an 'empty' answer is an honest note and
 * speaks its summary verbatim through the note path; withheld and
 * blocked answers are silent.
 *
 * `verifiedFigures` is an input, not a derivation the composer hides:
 * pass verifiedFiguresFromAnswer(answer), or a narrower list to speak
 * fewer figures. (A flexible completion's set is its own figures —
 * the caller's list does not narrow it, because the completion's
 * figures are the only provenance that class has.) The composer uses
 * numerals from the verified set alone, and the guard re-checks the
 * finished sentences against the same set.
 */
export function composeSpokenSummary(
  answer: ComposedAnswer,
  verifiedFigures: readonly SpokenVerifiedFigure[] = verifiedFiguresFromAnswer(
    answer,
  ),
  options?: { queryText?: string },
): string[] {
  if (!answer) return []
  if (answer.status === 'withheld' || answer.status === 'blocked') return []
  if (answer.status === 'empty') return composeSpokenNote(answer.summary ?? '')
  const figures =
    answer.status === 'flexible' ? flexibleVerifiedFigures(answer) : verifiedFigures
  const candidate = buildCandidate(answer, figures, options?.queryText)
  if (!candidate) return []
  if (!candidate.headline && candidate.middle.length === 0) return []
  return runLadder(candidate, figures)
}

/**
 * The honest-note path: the note's own terminal text, verbatim,
 * through (i) the numeral guard and (iii) the full validator — no
 * ladder, no paraphrase. Any sentence the guard would drop, or a
 * validator failure on the whole, is silence: a note speaks whole
 * or not at all, because its wording IS the terminal's honesty.
 * Notes carry no figures, so the verified set is empty.
 */
export function composeSpokenNote(text: string): string[] {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return []
  const sentences = splitSentences(trimmed)
  if (guardSpokenSentences(sentences, []).length !== sentences.length) return []
  if (!spokenValidator.validate(trimmed, []).pass) return []
  return sentences
}

/* --------------------- the modality planner ----------------------- */

/** A landed terminal the voice layer should speak, with its sentences. */
export interface TerminalSpeechPlan {
  /** The terminal object (answer or note) — the speak-once key. */
  target: object
  /** The sentences to speak; empty = the terminal is silent by class. */
  sentences: string[]
}

/**
 * The modality gate as a pure planner (Lane A8): given the session's
 * landed state, decide whether a terminal speaks and compose what
 * it says. Speech fires iff the LANDED terminal's own request
 * carries the 'voice' origin stamp — the stamp, never the ambient
 * voice-mode flag, so a voice run landing after a later typed
 * submit still speaks (its terminal is the current one only while
 * its request and ask generation are current), and a typed run in a
 * voice session never speaks. The caller marks `target` spoken
 * before speaking, so each landed terminal speaks exactly once;
 * a superseding terminal is a new target and replaces the old
 * utterance through the driver's own stop-then-speak semantics.
 * Interim/progressive state is never an input here.
 */
export function planTerminalSpeech(input: {
  answer: ComposedAnswer | null
  note: { id: number; text: string } | null
  request: { id: number; epoch?: number; queryText: string } | null
  askEpoch: number
  origin: { requestId: number; source: AnswerRequestOrigin } | null
}): TerminalSpeechPlan | null {
  const { answer, note, request, askEpoch, origin } = input
  if (!request || !origin) return null
  if (origin.requestId !== request.id || origin.source !== 'voice') return null
  if ((request.epoch ?? 0) !== askEpoch) return null
  if (answer) {
    return {
      target: answer,
      sentences: composeSpokenSummary(answer, undefined, {
        queryText: request.queryText,
      }),
    }
  }
  if (note && note.id === request.id) {
    return { target: note, sentences: composeSpokenNote(note.text) }
  }
  return null
}
