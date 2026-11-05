/**
 * Jev judgment sets for the conversational stack (plan C3) — ONE
 * module, unified by the completion-drive coordinator (2026-11-02)
 * from the client-pipeline copy and the server-route copy, which were
 * built in parallel against the same plan and flagged for this merge.
 *
 * The canonical contract both sides now code against:
 *
 *   POST /api/muse/jev  { set: 'J-LOOP' | 'J-BRANCH' | 'J-PHRASE' |
 *                         'J-GEN' | 'J-INQUIRY', state, questions }
 *     -> { answers: { [questionId]: JevAnswer }, model, latencyMs }
 *
 * The CLIENT authors the questions (it knows the criterion ids and
 * texts; question ids are semantic — `criterion:<criterionId>` — so a
 * failing Noul names its criterion and the loop's gap list needs no
 * positional mapping). The ROUTE validates the questions and forwards
 * them to TypeSafe System One; a caller that supplies no questions
 * gets the label-based fallback builders (questionsForSet), whose
 * positional ids serve route-level tests only. The TypeSafe wire is
 * the docs' keyed-object shape (docs.typesafe.ai/api/system-one.md,
 * read 2026-11-02), NOT the plan annex's array.
 *
 * Answers are the wire-mapped shape on both sides: Noul carries a
 * probability, Score an expected value plus its distribution, Choice
 * a `selected` option plus its distribution. Every consumer reads
 * answers through noulProbability / scoreExpected / choiceSelection.
 *
 * Thresholds are named constants because the loop, the modal trigger,
 * and the phrasing gate each compare against a different one, and a
 * bare number at a comparison site cannot say which rule it
 * implements. The server copy's shorter names survive as aliases of
 * the same values — one source of truth, both import surfaces.
 */

export type JevSetId = 'J-LOOP' | 'J-BRANCH' | 'J-PHRASE' | 'J-GEN' | 'J-INQUIRY'
export const JEV_SET_IDS: readonly JevSetId[] = [
  'J-LOOP',
  'J-BRANCH',
  'J-PHRASE',
  'J-GEN',
  'J-INQUIRY',
]

/** The TypeSafe model alias the Jev route requests. */
export const JEV_MODEL = 'jev-latest'

export type JevQuestionType = 'noul' | 'score' | 'choice'

export interface JevQuestion {
  id: string
  type: JevQuestionType
  instructions: string
  /** Score: ordered level descriptions. Choice: option list or key-to-description map. */
  criteria?: string[] | Record<string, string>
}

/** The state object a set is evaluated over; bounded by the callers. */
export type JevState = Record<string, unknown> | string

/** Typed answers mapped back by question id from a System One reply. */
export type JevAnswer =
  | { type: 'noul'; probability: number }
  | { type: 'score'; expected: number; distribution: Record<string, number> }
  | { type: 'choice'; selected: string; distribution: Record<string, number> }

export interface JevEvaluation {
  answers: Record<string, JevAnswer>
  model: string
  latencyMs: number
}

/** The client transport seam: one call per judgment-set evaluation. */
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
/**
 * J-GEN accuracy bar (C13 refinement, owner-set): the general
 * answer's accuracy/confidence Score — two levels, so its expected
 * value reads on the 0-1 scale — must clear 0.98, or the answer
 * ships with its precision limit stated after the round cap.
 */
export const GEN_ACCURACY_TARGET = 0.98
/** J-GEN relevance bar, on the same 0-1 two-level Score scale. */
export const GEN_RELEVANCE_TARGET = 0.9
/**
 * J-INQUIRY bars (C13 refinement): a specific bridge is offered only
 * when its relevance Score AND its confidence Score each clear 0.90
 * (two-level Scores, expected values on the 0-1 scale). Below either
 * bar, the inquiry is the open question only — no manufactured tie-in.
 */
export const INQUIRY_RELEVANCE_THRESHOLD = 0.9
export const INQUIRY_CONFIDENCE_THRESHOLD = 0.9

/** Aliases from the server copy — same values, one source of truth. */
export const JEV_CRITERION_PASS = JEV_CRITERION_NOUL_THRESHOLD
export const JEV_SCORE_PASS = JEV_SCORE_THRESHOLD
export const JEV_BRANCH_FIRE = JEV_BRANCH_THRESHOLD
export const JEV_PHRASE_PASS = JEV_PHRASE_THRESHOLD

/* ------------------------------------------------------------------ */
/* Judgment sets — canonical (client-authored) builders                */
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
  'proximity-distance',
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

export const GEN_ACCURACY_QUESTION_ID = 'gen-accuracy'
export const GEN_RELEVANCE_QUESTION_ID = 'gen-relevance'

/**
 * J-GEN (plan C13 refinement): the general lane's judgment set. The
 * accuracy Score's two levels put its expected value on the 0-1
 * scale the owner's 0.98 bar is stated on; relevance uses the same
 * scale so both read the same way in the loop's gap list. The
 * deterministic arithmetic check (arithmetic-check.ts) runs beside
 * this set in code — Jev judges the assumptions, code owns the
 * multiplication, and a failed arithmetic check enters the loop as
 * a named gap exactly like a failed Score.
 */
export function genQuestions(): JevQuestion[] {
  return [
    {
      id: GEN_ACCURACY_QUESTION_ID,
      type: 'score' as const,
      instructions:
        'How accurate and well-supported is this general answer under its stated assumptions?',
      criteria: [
        'inaccurate, unsupported, or wrong under its stated assumptions',
        'accurate and well-supported under its stated assumptions',
      ],
    },
    {
      id: GEN_RELEVANCE_QUESTION_ID,
      type: 'score' as const,
      instructions: 'How directly does this general answer address the question asked?',
      criteria: [
        'answers a different question',
        'directly addresses the question asked',
      ],
    },
  ]
}

export const INQUIRY_CHOICE_QUESTION_ID = 'inquiry-choice'
/** The explicit no-bridge option in the J-INQUIRY Choice set. */
export const INQUIRY_NONE_OPTION = 'none'

export function inquiryRelevanceQuestionId(candidateId: string): string {
  return `inquiry-relevance:${candidateId}`
}

export function inquiryConfidenceQuestionId(candidateId: string): string {
  return `inquiry-confidence:${candidateId}`
}

/**
 * J-INQUIRY (plan C13 refinement, beat 2): a Choice among the
 * candidate underlying-intent bridges PLUS the explicit 'none'
 * option, and a relevance + confidence Score per candidate. A
 * specific bridge renders only when the Choice selects it AND both
 * of its Scores clear their 0.90 bars; anything else is the open
 * question only.
 */
export function inquiryQuestions(
  candidates: readonly { id: string; offerText: string }[],
): JevQuestion[] {
  return [
    {
      id: INQUIRY_CHOICE_QUESTION_ID,
      type: 'choice' as const,
      instructions:
        'Which candidate, if any, names what this reader is plausibly actually after, ' +
        'in a way this place-data tool can genuinely serve?',
      criteria: [...candidates.map((c) => c.id), INQUIRY_NONE_OPTION],
    },
    ...candidates.flatMap((candidate): JevQuestion[] => [
      {
        id: inquiryRelevanceQuestionId(candidate.id),
        type: 'score' as const,
        instructions:
          `How relevant is this bridge to the reader's actual question and to this ` +
          `tool's real capabilities: ${candidate.offerText}`,
        criteria: ['not relevant to this reader or this tool', 'genuinely relevant'],
      },
      {
        id: inquiryConfidenceQuestionId(candidate.id),
        type: 'score' as const,
        instructions:
          `How confident is it that this bridge names what the reader is actually after: ` +
          candidate.offerText,
        criteria: ['speculative guess', 'well-grounded in the question asked'],
      },
    ]),
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

/* ------------------------------------------------------------------ */
/* Fallback builders (route-level, label criteria, positional ids)     */
/* ------------------------------------------------------------------ */

const RELEVANCE_CRITERIA: readonly string[] = [
  'answers a different question',
  'partially addresses the question asked',
  'directly and fully addresses the question asked',
]

const COMPLETENESS_CRITERIA: readonly string[] = [
  'major stated criteria missing',
  'all criteria present but thin in places',
  'every stated criterion fleshed out with its evidence',
]

/**
 * The server copy's label-based J-LOOP: one Noul per criterion LABEL,
 * ids positional (`criterion_<i>`). Used only when a route caller
 * supplies criteria labels and no questions of its own — the live
 * client path always authors semantic-id questions instead.
 */
export function loopQuestionsFromLabels(criteria: readonly string[]): JevQuestion[] {
  const questions: JevQuestion[] = criteria.map((text, i) => ({
    id: `criterion_${i}`,
    type: 'noul' as const,
    instructions:
      `Criterion ${text} is addressed in the answer with evidence ` +
      '(a figure, a cited finding, or an explicit not-measurable label).',
  }))
  questions.push(
    {
      id: 'relevance',
      type: 'score',
      instructions: 'How relevant is the answer to the question asked?',
      criteria: [...RELEVANCE_CRITERIA],
    },
    {
      id: 'completeness',
      type: 'score',
      instructions: 'How complete is the answer against its stated criteria?',
      criteria: [...COMPLETENESS_CRITERIA],
    },
  )
  return questions
}

function branchQuestionsFallback(): JevQuestion[] {
  return [
    {
      id: 'branch_exists',
      type: 'noul',
      instructions:
        'A clean, high-value branch point exists here: a user-context choice ' +
        '(yes/no or a short option set) whose answer materially changes how a ' +
        'stated criterion is interpreted.',
    },
    {
      id: 'branch_kind',
      type: 'choice',
      instructions: 'Which catalogued branch point is this?',
      criteria: {
        transport_mode:
          'Transport mode for a proximity criterion: whether the reader has a car changes what counts as near.',
        school_level:
          'School level for a schools criterion: elementary, middle, or high school changes which schools count.',
        budget_anchor:
          'Budget anchor for an affordability criterion: the figure the reader anchors affordability to.',
        none_of_these: 'None of the catalogued branch points.',
      },
    },
  ]
}

function phraseQuestionsFallback(): JevQuestion[] {
  return [
    {
      id: 'phrase_specific',
      type: 'noul',
      instructions:
        "As phrased, this question is clearly and specifically relevant to the user's " +
        'current request (it names the actual subject and the decision it drives, in ' +
        "the user's own context).",
    },
  ]
}

export function questionsForSet(set: JevSetId, criteria: readonly string[] = []): JevQuestion[] {
  switch (set) {
    case 'J-LOOP':
      return loopQuestionsFromLabels(criteria)
    case 'J-BRANCH':
      return branchQuestionsFallback()
    case 'J-PHRASE':
      return phraseQuestionsFallback()
    case 'J-GEN':
      return genQuestions()
    case 'J-INQUIRY':
      // Route-level fallback: the label criteria carry candidate ids.
      return inquiryQuestions(criteria.map((id) => ({ id, offerText: id })))
  }
}

/* ------------------------------------------------------------------ */
/* Answer readers                                                      */
/* ------------------------------------------------------------------ */

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
  return answer && answer.type === 'choice' ? answer.selected : null
}

/* ------------------------------------------------------------------ */
/* Client transport                                                    */
/* ------------------------------------------------------------------ */

/**
 * The default browser transport: POST to the Jev route. Any failure
 * (no route yet, 500, malformed reply) throws, and every consumer
 * treats a throw as "the check did not run" — the loop is skipped, no
 * modal interjects, and no Jev claim is made anywhere (plan invariant
 * 3: degradation is labelled, never silent, and never a user-facing
 * failure).
 */
export function createHttpJevTransport(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): JevTransport {
  return async ({ set, state }) => {
    const questions =
      set === 'J-LOOP'
        ? loopQuestions(loopCriteriaFromState(state))
        : set === 'J-BRANCH'
          ? branchQuestions()
          : set === 'J-GEN'
            ? genQuestions()
            : set === 'J-INQUIRY'
              ? inquiryQuestions(inquiryCandidatesFromState(state))
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

/** The inquiry set's candidates ride in the state the general runner builds. */
export function inquiryCandidatesFromState(
  state: Record<string, unknown>,
): { id: string; offerText: string }[] {
  const candidates = state.candidates
  if (!Array.isArray(candidates)) return []
  return candidates.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { id, offerText } = entry as { id?: unknown; offerText?: unknown }
    return typeof id === 'string' && typeof offerText === 'string' ? [{ id, offerText }] : []
  })
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

/* ------------------------------------------------------------------ */
/* TypeSafe System One wire (server side)                              */
/* ------------------------------------------------------------------ */

/**
 * The System One wire request (docs.typesafe.ai/api/system-one.md,
 * read 2026-11-02): POST /v1/systemone with { model, state,
 * questions } where questions is an object keyed by question name,
 * each { type, instructions, criteria? }. The plan annex described
 * an array; the live OpenAPI schema on that page is a keyed object,
 * and the docs are the transport's source of truth.
 */
export interface SystemOneRequest {
  model: string
  state: JevState
  questions: Record<string, { type: JevQuestionType; instructions: string; criteria?: string[] | Record<string, string> }>
}

function systemOneQuestions(
  questions: readonly JevQuestion[],
): SystemOneRequest['questions'] {
  const out: SystemOneRequest['questions'] = {}
  for (const q of questions) {
    out[q.id] = {
      type: q.type,
      instructions: q.instructions,
      ...(q.criteria ? { criteria: q.criteria } : {}),
    }
  }
  return out
}

/** Wire request from caller-supplied questions (the live path). */
export function buildSystemOneRequestFromQuestions(
  state: JevState,
  questions: readonly JevQuestion[],
): SystemOneRequest {
  return { model: JEV_MODEL, state, questions: systemOneQuestions(questions) }
}

/** Wire request from a set + label criteria (the fallback path). */
export function buildSystemOneRequest(set: JevSetId, state: JevState, criteria: readonly string[] = []): SystemOneRequest {
  return {
    model: JEV_MODEL,
    state,
    questions: systemOneQuestions(questionsForSet(set, criteria)),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(v)) return out
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
  }
  return out
}

/**
 * Map a System One response body onto typed answers by id. The wire
 * shapes are the docs' examples: Noul answers carry `noul`, Score
 * answers carry `score` plus `probabilities`, Choice answers carry
 * `choice` plus `probabilities`. An answer that does not match its
 * question's type is dropped, so a malformed reply degrades the
 * caller's coverage instead of inventing a value. Returns null when
 * the body is not a System One response at all.
 */
export function mapSystemOneResponse(
  body: unknown,
  questions: readonly JevQuestion[],
  latencyMs: number,
): JevEvaluation | null {
  if (!isRecord(body) || !isRecord(body.answers) || typeof body.model !== 'string') return null
  const answers: Record<string, JevAnswer> = {}
  for (const q of questions) {
    const raw = body.answers[q.id]
    if (!isRecord(raw)) continue
    if (q.type === 'noul' && typeof raw.noul === 'number' && Number.isFinite(raw.noul)) {
      answers[q.id] = { type: 'noul', probability: raw.noul }
    } else if (q.type === 'score' && typeof raw.score === 'number' && Number.isFinite(raw.score)) {
      answers[q.id] = { type: 'score', expected: raw.score, distribution: numberMap(raw.probabilities) }
    } else if (q.type === 'choice' && typeof raw.choice === 'string') {
      answers[q.id] = { type: 'choice', selected: raw.choice, distribution: numberMap(raw.probabilities) }
    }
  }
  return { answers, model: body.model, latencyMs }
}
