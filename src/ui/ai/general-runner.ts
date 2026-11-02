/**
 * The general lane's runner (plan C13 + the two-beat refinement,
 * owner design pass 2026-11-02 11:10 HST). Sibling to
 * answer-runner.ts: the data pipeline's contract is untouched, and
 * this runner serves the questions that pipeline cannot — genuinely
 * off-domain ones — in two beats.
 *
 * BEAT 1 — the answer. Spark answers through the provider's general
 * method (the existing proxy; functions/api/muse/general). The
 * answer runs the J-GEN loop: a Jev accuracy Score against the
 * owner-set 0.98 bar and a relevance Score, PLUS the deterministic
 * arithmetic check, whose failures enter the loop as named gaps
 * exactly like a failed Score (code owns arithmetic; Jev judges the
 * assumptions). Patches are revision calls carrying the gaps
 * verbatim, capped at the shared loop round cap; the best version
 * ships, and a version still below bar after the cap ships with its
 * precision limit stated — never dressed as confident.
 *
 * Degradation (invariant 3): when the Jev route is unavailable
 * (transport throws — the route answers jev_unavailable until the
 * owner sets TYPESAFE_API_KEY), the general answer still ships, the
 * arithmetic check still runs (it is deterministic and always
 * runs), and the outcome records jev.ran = false — the diagnostics
 * label — so no Jev claim is made anywhere.
 *
 * BEAT 2 — the inquiry. Exactly one inquiry turn under the answer,
 * once per session thread: Jev Choice among the candidate bridges
 * plus explicit 'none', each candidate Scored for relevance and
 * confidence. A specific bridge renders only at relevance >= 0.90
 * AND confidence >= 0.90; otherwise the open question only. A
 * wave-off closes the inquiry for the session (core/ai/general.ts);
 * a reply routes through the normal Ask pipeline as a first-class
 * request — this runner never sees it.
 *
 * VALIDATOR SEPARATION: nothing here imports the figure-provenance
 * validator. General prose is a distinct class ('general' on every
 * result) and cannot be blocked by invented_numeral; data answers
 * are ComposedAnswers from the data pipeline and cannot carry this
 * class or its label.
 */
import {
  arithmeticGap,
  checkArithmetic,
  type ArithmeticCheckResult,
} from '../../core/ai/arithmetic-check'
import {
  GENERAL_ANSWER_LABEL,
  OPEN_INQUIRY_TEXT,
  candidateBridgesFor,
  markInquiryAsked,
  readInquirySession,
  type BridgeCandidate,
  type InquirySession,
} from '../../core/ai/general'
import {
  GEN_ACCURACY_QUESTION_ID,
  GEN_ACCURACY_TARGET,
  GEN_RELEVANCE_QUESTION_ID,
  GEN_RELEVANCE_TARGET,
  INQUIRY_CHOICE_QUESTION_ID,
  INQUIRY_CONFIDENCE_THRESHOLD,
  INQUIRY_NONE_OPTION,
  INQUIRY_RELEVANCE_THRESHOLD,
  JEV_LOOP_MAX_ROUNDS,
  choiceSelection,
  createHttpJevTransport,
  inquiryConfidenceQuestionId,
  inquiryRelevanceQuestionId,
  scoreExpected,
  type JevTransport,
} from '../../core/ai/jev-judgments'
import type { MuseProvider } from '../../core/ai/provider'

export interface GeneralInquiry {
  kind: 'open' | 'specific'
  /** The one inquiry turn's full text: the bridge offer (specific only) + the open question. */
  text: string
  bridge?: BridgeCandidate
}

export interface GeneralAnswerData {
  /** The prose class, literal: general answers, and only general answers, carry it. */
  proseClass: 'general'
  label: string
  text: string
  /** One clause stating the precision limit, present exactly when the shipped version is below bar. */
  precisionLimit: string | null
  arithmetic: ArithmeticCheckResult
  jev: {
    ran: boolean
    accuracy: number | null
    relevance: number | null
    roundsUsed: number
  }
  inquiry: GeneralInquiry | null
  timings: Record<string, number>
}

export interface GeneralRunnerDeps {
  provider: MuseProvider
  /** Defaults to the HTTP Jev transport; a throw degrades to no-loop (see header). */
  jevTransport?: JevTransport
  /** Session state for the inquiry; defaults to the stored session record. */
  session?: InquirySession
  /** Called when the inquiry turn is shown; defaults to the stored session write. */
  markAsked?: () => void
  signal?: AbortSignal
}

interface GeneralVersion {
  text: string
  arithmetic: ArithmeticCheckResult
  accuracy: number | null
  relevance: number | null
  gaps: string[]
}

const ACCURACY_GAP = `Accuracy is below the ${GEN_ACCURACY_TARGET} bar`
const RELEVANCE_GAP = 'Relevance is below the bar'
const ARITHMETIC_PRECISION_LIMIT =
  'Precision limit: the arithmetic in this answer could not be verified, so treat its figures as approximate.'
const ESTIMATE_PRECISION_LIMIT =
  'Precision limit: this answer is an estimate under the stated assumptions, not an exact count.'

function versionScore(version: GeneralVersion): [number, number, number] {
  return [
    version.arithmetic.passed ? 1 : 0,
    version.accuracy ?? -1,
    version.relevance ?? -1,
  ]
}

function isBetter(candidate: GeneralVersion, best: GeneralVersion): boolean {
  const a = versionScore(candidate)
  const b = versionScore(best)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!
  }
  return false
}

/**
 * Beat 2's evaluation: the Choice selects at most one candidate, and
 * that candidate's two Scores must both clear their bars. Any other
 * outcome — 'none' selected, a missing answer, a transport failure,
 * a below-bar Score — is the open question only.
 */
export async function evaluateInquiry(input: {
  queryText: string
  answerText: string
  jevTransport: JevTransport
}): Promise<GeneralInquiry> {
  const candidates = candidateBridgesFor(input.queryText)
  const open: GeneralInquiry = { kind: 'open', text: OPEN_INQUIRY_TEXT }
  let answers: Record<string, import('../../core/ai/jev-judgments').JevAnswer>
  try {
    const reply = await input.jevTransport({
      set: 'J-INQUIRY',
      state: {
        question: input.queryText,
        answerSummary: input.answerText,
        candidates: candidates.map((c) => ({ id: c.id, offerText: c.offerText })),
      },
    })
    answers = reply.answers
  } catch {
    return open
  }
  const selected = choiceSelection(answers, INQUIRY_CHOICE_QUESTION_ID)
  if (!selected || selected === INQUIRY_NONE_OPTION) return open
  const bridge = candidates.find((c) => c.id === selected)
  if (!bridge) return open
  const relevance = scoreExpected(answers, inquiryRelevanceQuestionId(bridge.id))
  const confidence = scoreExpected(answers, inquiryConfidenceQuestionId(bridge.id))
  if (
    relevance === null ||
    confidence === null ||
    relevance < INQUIRY_RELEVANCE_THRESHOLD ||
    confidence < INQUIRY_CONFIDENCE_THRESHOLD
  ) {
    return open
  }
  return { kind: 'specific', bridge, text: `${bridge.offerText} ${OPEN_INQUIRY_TEXT}` }
}

/** Run the general lane for one off-domain question. */
export async function composeGeneralAnswer(input: {
  queryText: string
  deps: GeneralRunnerDeps
}): Promise<GeneralAnswerData> {
  const { deps } = input
  const timings: Record<string, number> = {}
  const jevTransport = deps.jevTransport ?? createHttpJevTransport()
  const session = deps.session ?? readInquirySession()
  const signal = deps.signal ?? new AbortController().signal

  const evaluate = async (
    text: string,
  ): Promise<{ version: GeneralVersion; jevRan: boolean }> => {
    // The arithmetic check is deterministic and always runs,
    // including when the Jev route is unavailable.
    const arithmetic = checkArithmetic(text, input.queryText)
    const gaps: string[] = arithmetic.failures.map(arithmeticGap)
    let accuracy: number | null = null
    let relevance: number | null = null
    let jevRan = true
    const started = performance.now()
    try {
      const reply = await jevTransport({
        set: 'J-GEN',
        state: { question: input.queryText, answerSummary: text },
      })
      accuracy = scoreExpected(reply.answers, GEN_ACCURACY_QUESTION_ID)
      relevance = scoreExpected(reply.answers, GEN_RELEVANCE_QUESTION_ID)
      if (accuracy === null || accuracy < GEN_ACCURACY_TARGET) gaps.push(ACCURACY_GAP)
      if (relevance === null || relevance < GEN_RELEVANCE_TARGET) gaps.push(RELEVANCE_GAP)
    } catch {
      // Jev route unavailable: the answer still ships, no Jev claim
      // is recorded, and only the deterministic gaps drive the loop
      // (with no patch evaluation to trust, a Jev-driven patch round
      // would be unverifiable — the loop stops at the first version
      // unless arithmetic alone failed; see the round loop below).
      jevRan = false
    } finally {
      timings['jev-round'] = (timings['jev-round'] ?? 0) + (performance.now() - started)
    }
    return { version: { text, arithmetic, accuracy, relevance, gaps }, jevRan }
  }

  const first = await deps.provider.general({ queryText: input.queryText }, signal)
  if (!first.prose.trim()) {
    throw new Error('general provider returned no prose')
  }
  let { version: best, jevRan } = await evaluate(first.prose.trim())
  let roundsUsed = 0

  // Patch rounds: a revision carries the named gaps verbatim. When
  // Jev did not run, only arithmetic gaps can drive a round — a
  // patch is then judged by the same deterministic check.
  while (
    best.gaps.length > 0 &&
    roundsUsed < JEV_LOOP_MAX_ROUNDS &&
    (jevRan || best.gaps.some((gap) => gap.startsWith('Arithmetic check failed')))
  ) {
    const gaps = [...best.gaps]
    roundsUsed += 1
    let patched: string | null = null
    try {
      const reply = await deps.provider.general(
        { queryText: input.queryText, revision: { answerText: best.text, gaps } },
        signal,
      )
      patched = reply.prose.trim() ? reply.prose.trim() : null
    } catch {
      patched = null
    }
    if (patched === null) break
    const evaluated = await evaluate(patched)
    jevRan = jevRan || evaluated.jevRan
    // A patch that does not strictly improve ends the loop: the
    // best grounded version stands, and re-patching against the
    // same gaps would spend rounds without new evidence.
    if (!isBetter(evaluated.version, best)) break
    best = evaluated.version
  }

  const precisionLimit =
    best.gaps.length === 0
      ? null
      : !best.arithmetic.passed
        ? ARITHMETIC_PRECISION_LIMIT
        : ESTIMATE_PRECISION_LIMIT

  // Beat 2: exactly one inquiry turn, once per session thread. A
  // session that already asked — or was waved off — gets none.
  let inquiry: GeneralInquiry | null = null
  if (!session.asked && !session.wavedOff) {
    const started = performance.now()
    inquiry = await evaluateInquiry({
      queryText: input.queryText,
      answerText: best.text,
      jevTransport,
    })
    timings['inquiry'] = performance.now() - started
    ;(deps.markAsked ?? (() => markInquiryAsked()))()
  }

  return {
    proseClass: 'general',
    label: GENERAL_ANSWER_LABEL,
    text: best.text,
    precisionLimit,
    arithmetic: best.arithmetic,
    jev: {
      ran: jevRan,
      accuracy: best.accuracy,
      relevance: best.relevance,
      roundsUsed,
    },
    inquiry,
    timings,
  }
}
