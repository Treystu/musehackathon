/**
 * Jev judgment-set definitions (conversational stack plan C3), as data.
 *
 * The definitions live here — not inside the server route and not
 * inside the loop — so hermetic tests assert the exact questions the
 * client asks without a network call, and a scripted transport stub
 * implements the same request/response mapping the route does:
 *
 *   POST /api/muse/jev  { set: 'loop' | 'branch' | 'phrase', state }
 *     -> { answers: { [questionId]: JevAnswer }, model?, latencyMs? }
 *
 * Noul answers map to a probability, Score answers to an expected
 * value plus its distribution, Choice answers to a selection plus its
 * distribution (plan annex C3, exact request shape).
 *
 * NOTE (client-pipeline build, 2026-11-02): the server-side sibling
 * building the Jev route is expected to own this module. This is the
 * client-side copy, written exactly per plan C3; if the sibling's
 * copy also lands, the coordinator merges the two into one module —
 * the shapes below are the contract both sides code against.
 */

export type JevSetId = 'loop' | 'branch' | 'phrase'

export interface JevQuestion {
  id: string
  type: 'noul' | 'score' | 'choice'
  instructions: string
  /** Score levels / Choice options, in order, when the type carries them. */
  criteria?: string[]
}

export type JevAnswer =
  | { type: 'noul'; probability: number }
  | { type: 'score'; expected: number; distribution: number[] }
  | { type: 'choice'; selection: string; distribution: number[] }

/** The transport seam: one call per judgment-set evaluation. */
export type JevTransport = (request: {
  set: JevSetId
  state: Record<string, unknown>
}) => Promise<{ answers: Record<string, JevAnswer>; model?: string; latencyMs?: number }>

/* ------------------------------------------------------------------ */
/* Thresholds (plan C3 — named constants, boundary-tested)             */
/* ------------------------------------------------------------------ */

/** A criterion Noul passes at or above this probability. */
export const JEV_CRITERION_NOUL_THRESHOLD = 0.8
/** A Score (relevance / completeness) passes at or above this expected value, of 2. */
export const JEV_SCORE_THRESHOLD = 1.5
/** J-BRANCH fires at or above this probability. */
export const JEV_BRANCH_THRESHOLD = 0.75
/** J-PHRASE permits interjection at or above this probability. */
export const JEV_PHRASE_THRESHOLD = 0.8
/** The Jev loop runs at most this many patch rounds (plan C4). */
export const JEV_LOOP_MAX_ROUNDS = 2

/* ------------------------------------------------------------------ */
/* Judgment sets                                                       */
/* ------------------------------------------------------------------ */

/** The per-criterion Noul question id for J-LOOP, by criterion id. */
export function loopCriterionQuestionId(criterionId: string): string {
  return `criterion:${criterionId}`
}

export const LOOP_RELEVANCE_QUESTION_ID = 'relevance'
export const LOOP_COMPLETENESS_QUESTION_ID = 'completeness'

/**
 * J-LOOP (plan C3): one Noul per stated criterion, plus the relevance
 * and completeness Scores. The failing outputs ARE the gap list — a
 * failed criterion Noul names its criterion; a failed Score names its
 * dimension. There is no separate gap-generation step.
 */
export function loopQuestions(criteria: readonly { id: string; text: string }[]): JevQuestion[] {
  return [
    ...criteria.map((criterion) => ({
      id: loopCriterionQuestionId(criterion.id),
      type: 'noul' as const,
      instructions:
        `Criterion ${criterion.text} is addressed in the answer with evidence ` +
        '(a figure, a cited finding, or an explicit not-measurable label).',
    })),
    {
      id: LOOP_RELEVANCE_QUESTION_ID,
      type: 'score' as const,
      instructions: 'How directly the answer addresses the question asked.',
      criteria: [
        'answers a different question',
        'partially addresses the question asked',
        'directly and fully addresses the question asked',
      ],
    },
    {
      id: LOOP_COMPLETENESS_QUESTION_ID,
      type: 'score' as const,
      instructions: 'How completely the answer covers the stated criteria.',
      criteria: [
        'major stated criteria missing',
        'all criteria present but thin in places',
        'every stated criterion fleshed out with its evidence',
      ],
    },
  ]
}

export const BRANCH_QUESTION_ID = 'branch-exists'
export const BRANCH_CHOICE_QUESTION_ID = 'branch-which'

/** The catalogued branch ids J-BRANCH may name (plan C3/C7). */
export const BRANCH_CHOICE_OPTIONS: readonly string[] = [
  'transport',
  'school-level',
  'budget-anchor',
  'none-of-these',
]

/**
 * J-BRANCH (plan C3): does a clean, high-value branch point exist at
 * this stage, and if so which catalogued branch is it. Only a
 * catalogued branch with a defined option set and defined
 * interpretation effects may interject.
 */
export function branchQuestions(): JevQuestion[] {
  return [
    {
      id: BRANCH_QUESTION_ID,
      type: 'noul' as const,
      instructions:
        'A clean, high-value branch point exists here: a user-context choice ' +
        '(yes/no or a short option set) whose answer materially changes how a ' +
        'stated criterion is interpreted.',
    },
    {
      id: BRANCH_CHOICE_QUESTION_ID,
      type: 'choice' as const,
      instructions: 'Which catalogued branch point this is.',
      criteria: [...BRANCH_CHOICE_OPTIONS],
    },
  ]
}

export const PHRASE_QUESTION_ID = 'phrase-specific'

/**
 * J-PHRASE (plan C3/C8): the specificity gate on a drafted modal
 * question. A modal that would read as generic does not interject,
 * whatever J-BRANCH said.
 */
export function phraseQuestions(): JevQuestion[] {
  return [
    {
      id: PHRASE_QUESTION_ID,
      type: 'noul' as const,
      instructions:
        'As phrased, this question is clearly and specifically relevant to the ' +
        "user's current request (it names the actual subject and the decision " +
        "it drives, in the user's own context).",
    },
  ]
}

/** Read a Noul probability out of a transport reply; absent or mistyped = null. */
export function noulProbability(
  answers: Record<string, JevAnswer>,
  questionId: string,
): number | null {
  const answer = answers[questionId]
  return answer && answer.type === 'noul' && Number.isFinite(answer.probability)
    ? answer.probability
    : null
}

/** Read a Score expected value out of a transport reply; absent or mistyped = null. */
export function scoreExpected(
  answers: Record<string, JevAnswer>,
  questionId: string,
): number | null {
  const answer = answers[questionId]
  return answer && answer.type === 'score' && Number.isFinite(answer.expected)
    ? answer.expected
    : null
}

/** Read a Choice selection out of a transport reply; absent or mistyped = null. */
export function choiceSelection(
  answers: Record<string, JevAnswer>,
  questionId: string,
): string | null {
  const answer = answers[questionId]
  return answer && answer.type === 'choice' ? answer.selection : null
}

/**
 * The default browser transport: POST to the Jev route the server
 * sibling registers. Any failure (no route yet, 500, malformed reply)
 * throws, and every consumer treats a throw as "the check did not
 * run" — the loop is skipped, no modal interjects, and no Jev claim
 * is made anywhere (plan invariant 3: degradation is labelled, never
 * silent, and never a user-facing failure).
 */
export function createHttpJevTransport(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): JevTransport {
  return async ({ set, state }) => {
    const questions =
      set === 'loop'
        ? loopQuestions(loopCriteriaFromState(state))
        : set === 'branch'
          ? branchQuestions()
          : phraseQuestions()
    const response = await fetcher('/api/muse/jev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ set, state, questions }),
    })
    if (!response.ok) throw new Error(`jev route: HTTP ${response.status}`)
    const body = (await response.json()) as {
      answers?: Record<string, JevAnswer>
      model?: string
      latencyMs?: number
    }
    if (!body.answers || typeof body.answers !== 'object') {
      throw new Error('jev route: malformed reply')
    }
    return { answers: body.answers, model: body.model, latencyMs: body.latencyMs }
  }
}

/** The loop set's criteria ride in the state the runner builds (see jev-loop.ts). */
export function loopCriteriaFromState(
  state: Record<string, unknown>,
): { id: string; text: string }[] {
  const criteria = state.criteria
  if (!Array.isArray(criteria)) return []
  return criteria.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { id, text } = entry as { id?: unknown; text?: unknown }
    return typeof id === 'string' && typeof text === 'string' ? [{ id, text }] : []
  })
}
