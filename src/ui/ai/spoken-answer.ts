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
 */
import type {
  AnswerFigure,
  ComposedAnswer,
  CriterionEvidenceStatus,
} from '../../core/ai/answer'

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

/** The place a verified figure belongs to, for the spoken clause. */
function placeNameForFigure(
  answer: ComposedAnswer,
  figure: SpokenVerifiedFigure,
): string | null {
  for (const place of answer.places) {
    const match: AnswerFigure | undefined = place.figures.find(
      (f: AnswerFigure) => f.key === figure.key && f.value === figure.value,
    )
    if (match) return place.name
  }
  return null
}

/**
 * Compose the spoken summary for a verified answer.
 *
 * `verifiedFigures` is an input, not a derivation the composer hides:
 * pass verifiedFiguresFromAnswer(answer), or a narrower list to speak
 * fewer figures. The composer uses numerals from that list alone, and
 * the guard re-checks the finished sentences against the same list.
 */
export function composeSpokenSummary(
  answer: ComposedAnswer,
  verifiedFigures: readonly SpokenVerifiedFigure[] = verifiedFiguresFromAnswer(
    answer,
  ),
): string[] {
  if (!answer || answer.status !== 'verified') return []

  const sentences: string[] = []

  // Headline: the answer's own summary sentence. It is numeral-free
  // by construction in the pipeline; if a future summary carries a
  // numeral, the guard below decides whether it may be spoken.
  const headline = (answer.summary ?? '').trim()
  if (headline) sentences.push(headline)

  // One sentence per criterion: "<criterion>: <outcome words>", plus
  // a verified-figure clause for a Census criterion when the verified
  // list carries a figure for its key -- copied from the list, with
  // the place the card shows that figure for.
  for (const evidence of answer.criterionEvidence) {
    const label = spokenCriterionLabel(evidence.criterion)
    const outcome = OUTCOME_WORDS[evidence.status] ?? evidence.status
    let sentence = `${label}: ${outcome}.`
    if (evidence.kind === 'census' && evidence.status === 'met') {
      const figure = verifiedFigures.find((f) => f.key === evidence.criterion)
      if (figure) {
        const placeName = placeNameForFigure(answer, figure)
        sentence = placeName
          ? `${label}: ${outcome}, ${formatSpokenFigure(figure.value)} for ${placeName}.`
          : `${label}: ${outcome}, ${formatSpokenFigure(figure.value)}.`
      }
    }
    sentences.push(sentence)
  }

  if (sentences.length === 0) return []
  return guardSpokenSentences(sentences, verifiedFigures)
}
