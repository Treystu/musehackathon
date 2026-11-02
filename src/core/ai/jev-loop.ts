/**
 * The Jev iteration loop at compose (plan C4).
 *
 * Order (plan C4, exact): compose -> deterministic verify (facts) ->
 * J-LOOP -> [patch -> verify -> J-LOOP] x <=2 -> ship the best
 * grounded version. Verify runs FIRST so Jev never evaluates text
 * facts will reject, and re-runs after every patch; a patch that
 * breaks a figure is discarded and the prior grounded version stands
 * (invariant 1). Honest per-criterion labels survive every round
 * because versions are whole answers, never edited in place.
 *
 * Transport failure degrades honestly: the loop is skipped, the
 * composed answer ships, and no Jev claim is recorded anywhere
 * (invariant 3). The evaluation itself is one transport call per
 * round with parallel questions over a small state.
 */
import {
  JEV_CRITERION_NOUL_THRESHOLD,
  JEV_LOOP_MAX_ROUNDS,
  JEV_SCORE_THRESHOLD,
  LOOP_COMPLETENESS_QUESTION_ID,
  LOOP_RELEVANCE_QUESTION_ID,
  loopCriterionQuestionId,
  noulProbability,
  scoreExpected,
  type JevTransport,
} from './jev-judgments'

/** One evaluated version, in the plan annex's exact loop-state shape. */
export interface JevLoopVersion<TAnswer> {
  answer: TAnswer
  /** The version's answer text, as evaluated (kept for the patch request). */
  text: string
  verify: 'pass'
  noul: Record<string, number>
  relevance: number
  completeness: number
}

/** The loop state (plan annex C4, exact fields plus the answer payloads). */
export interface JevLoopState<TAnswer> {
  versions: JevLoopVersion<TAnswer>[]
  roundsUsed: number
}

export interface JevEvaluation {
  noul: Record<string, number>
  relevance: number
  completeness: number
  /** Named gaps, verbatim-shaped: failed criteria and failed dimensions. */
  gaps: string[]
  passed: boolean
}

/**
 * Evaluate one answer text against J-LOOP. Pure mapping over the
 * transport reply: the failing outputs ARE the gap list.
 */
export function evaluationFromAnswers(
  criteria: readonly { id: string; text: string }[],
  answers: Parameters<JevTransport>[0] extends never
    ? never
    : Record<string, import('./jev-judgments').JevAnswer>,
): JevEvaluation {
  const noul: Record<string, number> = {}
  const gaps: string[] = []
  for (const criterion of criteria) {
    const probability = noulProbability(answers, loopCriterionQuestionId(criterion.id))
    // A missing answer for a criterion is a fail for that criterion:
    // the loop may only claim what the evaluation actually returned.
    noul[criterion.id] = probability ?? 0
    if (probability === null || probability < JEV_CRITERION_NOUL_THRESHOLD) {
      gaps.push(`Criterion ${criterion.text} is not addressed with evidence`)
    }
  }
  const relevance = scoreExpected(answers, LOOP_RELEVANCE_QUESTION_ID) ?? 0
  if (relevance < JEV_SCORE_THRESHOLD) gaps.push('Relevance is below the bar')
  const completeness = scoreExpected(answers, LOOP_COMPLETENESS_QUESTION_ID) ?? 0
  if (completeness < JEV_SCORE_THRESHOLD) gaps.push('Completeness is below the bar')
  return { noul, relevance, completeness, gaps, passed: gaps.length === 0 }
}

/**
 * Best-version selection as a pure function over the loop state
 * (plan C4): among grounded versions (every version in the state is
 * grounded — ungrounded patches never enter it), the most criterion
 * Nouls passing wins, then the higher relevance + completeness
 * expectations. Ties keep the EARLIER version: a later patch that
 * does not strictly improve does not displace what already shipped.
 */
export function bestVersionIndex<TAnswer>(state: JevLoopState<TAnswer>): number {
  let best = 0
  for (let i = 1; i < state.versions.length; i++) {
    if (compareVersions(state.versions[i]!, state.versions[best]!) > 0) best = i
  }
  return best
}

function passingNouls(version: JevLoopVersion<unknown>): number {
  return Object.values(version.noul).filter((p) => p >= JEV_CRITERION_NOUL_THRESHOLD).length
}

function compareVersions(a: JevLoopVersion<unknown>, b: JevLoopVersion<unknown>): number {
  const byNouls = passingNouls(a) - passingNouls(b)
  if (byNouls !== 0) return byNouls
  return a.relevance + a.completeness - (b.relevance + b.completeness)
}

/** The J-LOOP state object for one answer (budget: small, structured fields only). */
export function loopStateFor(input: {
  answerText: string
  criteria: readonly { id: string; text: string }[]
  evidenceLabels: readonly string[]
  sourceCount: number
}): Record<string, unknown> {
  return {
    answerSummary: input.answerText,
    criteria: input.criteria.map((c) => ({ id: c.id, text: c.text })),
    evidenceLabels: [...input.evidenceLabels],
    sourceCount: input.sourceCount,
  }
}

export interface JevLoopDeps<TAnswer> {
  transport: JevTransport
  /** The stated criteria the loop judges, in answer order. */
  criteria: readonly { id: string; text: string }[]
  evidenceLabels: readonly string[]
  sourceCount: number
  /** Serialize a version for evaluation and for the patch request. */
  textOf: (answer: TAnswer) => string
  /** Deterministic verify for a candidate version; only 'pass' versions enter the state. */
  verifyOf: (answer: TAnswer) => boolean
  /**
   * ONE targeted patch call (plan C4): the current answer text + the
   * named gaps verbatim, instruction patch-only. Returns the patched
   * answer, or null when no patch is possible.
   */
  patch: (request: { answerText: string; gaps: string[]; instruction: 'patch-only' }) => Promise<TAnswer | null>
  /** Timing sink: one entry per Jev round and per patch, in milliseconds. */
  onTiming?: (stage: 'jev-round' | 'patch', ms: number) => void
}

export interface JevLoopOutcome<TAnswer> {
  /** The version to ship (the best grounded one). */
  answer: TAnswer
  state: JevLoopState<TAnswer>
  /** True when at least one Jev evaluation actually ran. */
  ran: boolean
}

/**
 * Run the loop over an already-verified composed answer. The caller
 * guarantees the initial answer passed deterministic verify; a patch
 * candidate that fails verifyOf is discarded before evaluation.
 */
export async function runJevLoop<TAnswer>(
  initial: TAnswer,
  deps: JevLoopDeps<TAnswer>,
): Promise<JevLoopOutcome<TAnswer>> {
  const state: JevLoopState<TAnswer> = { versions: [], roundsUsed: 0 }

  const evaluate = async (answer: TAnswer): Promise<JevEvaluation> => {
    const started = performance.now()
    try {
      const reply = await deps.transport({
        set: 'J-LOOP',
        state: loopStateFor({
          answerText: deps.textOf(answer),
          criteria: deps.criteria,
          evidenceLabels: deps.evidenceLabels,
          sourceCount: deps.sourceCount,
        }),
      })
      return evaluationFromAnswers(deps.criteria, reply.answers)
    } finally {
      deps.onTiming?.('jev-round', performance.now() - started)
    }
  }

  let first: JevEvaluation
  try {
    first = await evaluate(initial)
  } catch {
    // Jev transport failure: the loop is skipped, the answer ships,
    // and no Jev claim is made (the outcome's `ran` stays false).
    return { answer: initial, state, ran: false }
  }
  state.versions.push({
    answer: initial,
    text: deps.textOf(initial),
    verify: 'pass',
    noul: first.noul,
    relevance: first.relevance,
    completeness: first.completeness,
  })
  let gaps = first.gaps

  while (gaps.length > 0 && state.roundsUsed < JEV_LOOP_MAX_ROUNDS) {
    const current = state.versions[state.versions.length - 1]!
    const patchStarted = performance.now()
    let patched: TAnswer | null = null
    try {
      patched = await deps.patch({
        answerText: current.text,
        gaps: [...gaps],
        instruction: 'patch-only',
      })
    } catch {
      patched = null
    }
    deps.onTiming?.('patch', performance.now() - patchStarted)
    state.roundsUsed += 1
    if (patched === null) break
    // Verify re-runs after every patch (plan C4): a patch that breaks
    // a figure never enters the state; the prior grounded version stands.
    if (!deps.verifyOf(patched)) break
    let evaluation: JevEvaluation
    try {
      evaluation = await evaluate(patched)
    } catch {
      break
    }
    state.versions.push({
      answer: patched,
      text: deps.textOf(patched),
      verify: 'pass',
      noul: evaluation.noul,
      relevance: evaluation.relevance,
      completeness: evaluation.completeness,
    })
    gaps = evaluation.gaps
  }

  const best = state.versions[bestVersionIndex(state)]!
  return { answer: best.answer, state, ran: true }
}
