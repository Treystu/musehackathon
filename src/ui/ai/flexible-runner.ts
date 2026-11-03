/**
 * The flexible completion's orchestration (2026-11-02; core
 * contract in core/ai/flexible.ts). Sibling to general-runner.ts:
 * the strict pipeline's contract is untouched, and this runner runs
 * only when the strict lane terminated at research mismatch — the
 * pipeline's noCensusMatch marker, or research-named material
 * carried on an 'empty' answer (the runner's material-keyed
 * trigger, widened 2026-11-02).
 *
 * Order, on the hourglass seams the conversational stack already
 * owns: Spark drafts through the flexible route -> the extended
 * deterministic validator gates the draft (a failure is
 * fail-closed: this runner returns null and the strict lane's
 * honest note stands) -> the item-9 Jev loop evaluates and patches
 * (verify re-runs inside the loop after every patch, so a patch
 * that breaks a figure or a label never ships) -> the Wonder
 * verify bookend labels the result. Degradation mirrors the strict
 * stack's rules: a Jev transport failure ships the
 * validator-passed draft with jev 'not-run' and no Jev claim; a
 * bookend failure labels Wonder 'not-run' and claims nothing.
 */
import {
  conformFlexibleDraftRequest,
  flexibleAnswerText,
  parseFlexibleDraft,
  verifyFlexibleAnswer,
  EVIDENCE_CLASS_LABELS,
  type FlexibleAnswer,
  type FlexibleDraftRequest,
  type FlexibleTransport,
} from '../../core/ai/flexible'
import {
  buildVerifyPacket,
  wonderLabelFor,
  type VerifyTransport,
  type WonderLabel,
} from '../../core/ai/bookends'
import { runJevLoop } from '../../core/ai/jev-loop'
import type { JevTransport } from '../../core/ai/jev-judgments'
import type { ComposedAnswer } from '../../core/ai/answer'
import type { AreaRow } from '../../core/plugins/acs'

export interface FlexibleCompletionDeps {
  flexibleTransport: FlexibleTransport
  jevTransport: JevTransport
  verifyTransport: VerifyTransport
}

export interface FlexibleCompletionOutcome {
  flexible: FlexibleAnswer
  verification: {
    wonder: WonderLabel
    wonderConcerns?: string[]
    jev: { roundsUsed: number; passed: boolean } | 'not-run'
  }
  timings: Record<string, number>
}

/**
 * Every place the research named, from the pipeline's full
 * extraction record — not only the unresolved subset: a name that
 * resolved through the index but had no loaded row is still a
 * research-named place, and the validator's provenance check reads
 * the same full set the packet offers the draft.
 */
export function researchNamedPlacesOf(strictAnswer: ComposedAnswer): readonly string[] {
  return strictAnswer.researchNamedPlaces ?? strictAnswer.unresolvedCandidates
}

/** The draft request, built from what the strict pipeline actually gathered. */
export function flexibleDraftRequestFor(input: {
  queryText: string
  strictAnswer: ComposedAnswer
}): FlexibleDraftRequest {
  const { strictAnswer } = input
  const claims = [
    ...strictAnswer.places.flatMap((p) => p.claims),
    ...strictAnswer.generalClaims,
  ].map((claim) => ({ text: claim.text, sourceUrls: [...claim.sourceUrls] }))
  // Conformed to the route's packet limits at construction (core
  // conformFlexibleDraftRequest): the gathered material of a
  // multi-pass zero-match run legitimately exceeds the caps, and
  // the unconformed packet was refused whole — the designed
  // completion never engaged (measured 2026-11-03).
  return conformFlexibleDraftRequest({
    question: input.queryText,
    criteria: strictAnswer.researchCriteria.map((c) => c.label),
    researchPlaces: [...researchNamedPlacesOf(strictAnswer)],
    claims,
    sources: strictAnswer.sources.map((s) => ({ title: s.title, url: s.url })),
  })
}

/**
 * Complete one research-mismatch request. Returns null whenever
 * the completion cannot run or cannot pass its gate — the caller
 * keeps the strict answer (and its honest note) untouched.
 */
export async function composeFlexibleCompletion(input: {
  queryText: string
  strictAnswer: ComposedAnswer
  rows: readonly AreaRow[]
  /** The loop's criterion list (the runner's loopCriteriaFor output). */
  criteria: readonly { id: string; text: string }[]
  deps: FlexibleCompletionDeps
  /** Stage observer: 'jev' only when the loop is invoked, 'wonder-verify' only when the bookend is called. */
  onStage?: (stage: 'jev' | 'wonder-verify') => void
}): Promise<FlexibleCompletionOutcome | null> {
  const { strictAnswer, deps } = input
  const timings: Record<string, number> = {}
  const request = flexibleDraftRequestFor(input)
  const validationContext = {
    rows: input.rows,
    researchNamedPlaces: researchNamedPlacesOf(strictAnswer),
  }

  const draftStarted = performance.now()
  let rawDraft: unknown = null
  try {
    rawDraft = await deps.flexibleTransport(request)
  } catch {
    rawDraft = null
  }
  timings['flexible-draft'] = performance.now() - draftStarted
  let draft = parseFlexibleDraft(rawDraft)

  // The deterministic gate runs BEFORE the Jev loop, exactly as
  // verify runs before J-LOOP on the strict path: Jev never
  // evaluates a completion the facts would reject. A zero-place
  // draft fails the gate alongside the validator's own failures
  // when the research named places — a completion that names no
  // place does not answer a place question (Lane completion K0).
  const gateFailures = (candidate: FlexibleAnswer | null): string[] => {
    if (!candidate) return ['the draft could not be read']
    const failures = [...verifyFlexibleAnswer(candidate, validationContext).failures]
    if (
      candidate.places.length === 0 &&
      validationContext.researchNamedPlaces.length > 0
    ) {
      failures.push(
        'the completion named no places, though the research named places for the stated criteria',
      )
    }
    return failures
  }
  let failures = gateFailures(draft)
  if (failures.length > 0) {
    // ONE bounded re-draft (Lane completion K0, 2026-11-03; the
    // FM-11 budget discipline applied to the completion lane):
    // the owner's answer-every-time floor makes a single rejected
    // draft too cheap a terminal when the failure strings tell
    // the drafter exactly what to fix — the provenance failure
    // names the place, the zero-place failure names the omission.
    // A transport/parse failure retries the same request (a flap
    // is not a drafting error); a validator failure re-drafts as
    // a revision carrying the failure strings as its gaps. The
    // re-draft is held to the identical gate, and a second
    // failure ends the lane exactly as before (fail-closed — the
    // note stands). Draft calls for one completion: at most two,
    // plus the Jev loop's own patch calls below.
    const redraftStarted = performance.now()
    let rawRedraft: unknown = null
    try {
      rawRedraft = await deps.flexibleTransport(
        conformFlexibleDraftRequest({
          ...request,
          ...(draft
            ? { revision: { draftText: flexibleAnswerText(draft), gaps: failures } }
            : {}),
        }),
      )
    } catch {
      rawRedraft = null
    }
    timings['flexible-redraft'] = performance.now() - redraftStarted
    const redraft = parseFlexibleDraft(rawRedraft)
    if (redraft && gateFailures(redraft).length === 0) {
      draft = redraft
      failures = []
    }
  }
  if (!draft || failures.length > 0) return null

  let flexible = draft
  let jev: FlexibleCompletionOutcome['verification']['jev'] = 'not-run'

  if (input.criteria.length > 0) {
    const roundTimings: number[] = []
    const patchTimings: number[] = []
    input.onStage?.('jev')
    const outcome = await runJevLoop<FlexibleAnswer>(draft, {
      transport: deps.jevTransport,
      criteria: input.criteria,
      evidenceLabels: [
        ...strictAnswer.criterionEvidence.map((entry) => `${entry.criterion}: ${entry.status}`),
        ...([...new Set([
          ...draft.places.map((p) => p.evidenceClass),
          ...draft.figures.map((f) => f.evidenceClass),
        ])] as const).map((cls) => `evidence class: ${EVIDENCE_CLASS_LABELS[cls]}`),
      ],
      sourceCount: strictAnswer.sources.length,
      textOf: flexibleAnswerText,
      verifyOf: (candidate) => verifyFlexibleAnswer(candidate, validationContext).ok,
      patch: async ({ answerText, gaps }) => {
        let raw: unknown = null
        try {
          raw = await deps.flexibleTransport(
            conformFlexibleDraftRequest({
              ...request,
              revision: { draftText: answerText, gaps },
            }),
          )
        } catch {
          raw = null
        }
        return parseFlexibleDraft(raw)
      },
      onTiming: (stage, ms) => {
        if (stage === 'jev-round') roundTimings.push(ms)
        else patchTimings.push(ms)
      },
    })
    roundTimings.forEach((ms, i) => {
      timings[`flexible-jev-round-${i}`] = ms
    })
    patchTimings.forEach((ms, i) => {
      timings[`flexible-patch-${i}`] = ms
    })
    if (outcome.ran) {
      flexible = outcome.answer
      const bestVersion =
        outcome.state.versions.find((v) => v.answer === outcome.answer) ??
        outcome.state.versions[0]!
      jev = {
        roundsUsed: outcome.state.roundsUsed,
        passed:
          Object.values(bestVersion.noul).every((p) => p >= 0.8) &&
          bestVersion.relevance >= 1.5 &&
          bestVersion.completeness >= 1.5,
      }
    }
  }

  // The Wonder verify bookend, over a packet that carries the
  // completion's own shape: the prose as summary, the places with
  // their figures, the criterion evidence plus one entry per
  // evidence class the completion uses (the classes are part of
  // what the bookend is asked to verify).
  const verifyStarted = performance.now()
  input.onStage?.('wonder-verify')
  let wonder: WonderLabel = 'not-run'
  let wonderConcerns: string[] | undefined
  try {
    const classesPresent = [
      ...new Set([
        ...flexible.places.map((p) => p.evidenceClass),
        ...flexible.figures.map((f) => f.evidenceClass),
        ...flexible.places.flatMap((p) => p.figures.map((f) => f.evidenceClass)),
      ]),
    ]
    const verdict = await deps.verifyTransport(
      buildVerifyPacket({
        summary: flexible.prose,
        places: flexible.places.map((place) => ({
          name: place.name,
          figures: place.figures.map((f) => ({ key: f.label, value: f.value })),
        })),
        evidence: [
          ...strictAnswer.criterionEvidence.map((entry) => ({
            criterion: entry.criterion,
            status: entry.status,
            detail: entry.detail,
          })),
          ...classesPresent.map((cls) => ({
            criterion: `evidence:${cls}`,
            status: 'labelled',
            detail: EVIDENCE_CLASS_LABELS[cls],
          })),
        ],
        sources: strictAnswer.sources.map((s) => ({ title: s.title, url: s.url })),
        verifySummary:
          `flexible completion of a research-mismatch request; extended validator passed; ` +
          `${flexible.places.length} places; evidence classes: ${classesPresent.join(', ') || 'none'}`,
        placeDisplayLimit: 10,
      }),
    )
    wonder = wonderLabelFor(verdict)
    if (verdict?.verdict === 'concerns') {
      wonderConcerns = verdict.concerns.map((c) => c.detail)
    }
  } catch {
    wonder = 'not-run'
  }
  timings['flexible-verify'] = performance.now() - verifyStarted

  return {
    flexible,
    verification: {
      wonder,
      ...(wonderConcerns ? { wonderConcerns } : {}),
      jev,
    },
    timings,
  }
}
