/**
 * Narrow provider interface. Model calls sit behind these shapes so the
 * post-contest swap (provider swap, not rewrite) stays cheap. Validator,
 * meter, and disclosure import nothing from this file.
 */
import type { ValidatorFailure } from './validator'

export type IntentMode = 'lookup' | 'compare' | 'sweep_filter' | 'similarity'

export interface IntentRequest {
  /** Structured slots preferred (D5); raw text only where unavoidable. */
  slots: {
    modeHint?: IntentMode
    geographyHints: string[]
    metricHints: string[]
  }
  queryText?: string
  locale: 'en'
}

export interface ValidatedIntent {
  mode: IntentMode
  geographies: string[]
  metricKeys: string[]
  filters: { metricKey: string; op: 'gt' | 'lt' | 'eq_range'; value: number }[]
  clarificationNeeded: boolean
}

export interface IntentResult {
  intent: ValidatedIntent
  /** Model prose, if any. Must pass the validator before display. */
  prose?: string
}

export interface ExplainRequest {
  figureSetId: string
  values: { key: string; value: number | null; marginOfError?: number }[]
}
/** The same request ceiling enforced by the explain proxy parser. */
export const MAX_EXPLAIN_VALUES = 24
export interface ExplainResult {
  prose: string
  /**
   * True when the proxy's validator refused the model's prose. The figures are
   * still shown; the wording is not. Carried as a state rather than an empty
   * string so a withheld answer is never mistaken for a missing one.
   */
  withheld?: boolean
  /**
   * The validator class behind a proxy withhold, when the deployment reports
   * one. Closed union, so it can be counted without storing the prose.
   */
  withholdClass?: ValidatorFailure
}

export interface BriefingRequest {
  figureSetId: string
  /**
   * The pack's figures, already re-verified against their SourceRefs by
   * briefing.ts before this call. The model narrates these and only these;
   * it is never handed an unverified figure (plan section 6.2.7).
   */
  values: { key: string; value: number | null; marginOfError?: number }[]
}
/** The same request ceiling enforced by the briefing proxy parser. */
export const MAX_BRIEFING_VALUES = 64
export interface BriefingResult {
  prose: string
  /**
   * True when the proxy's validator refused the model's prose. The pack's
   * figures and appendix still ship; the wording does not. Same contract as
   * ExplainResult.withheld, for the same reason.
   */
  withheld?: boolean
  /** The validator class behind a proxy withhold, when reported. */
  withholdClass?: ValidatorFailure
}

/**
 * Deterministic narrative for the hermetic providers (stub + replay).
 * Slot-templated from the request only: it names the figure keys and
 * states no numeral, so it passes the F4 validator against any figure
 * set the caller supplies. A test double that returned free prose would
 * be a second, weaker path around the validator; this is not one.
 */
export function deterministicBriefingProse(req: BriefingRequest): string {
  const keys = req.values.map((v) => v.key).filter((k, i, all) => all.indexOf(k) === i)
  if (keys.length === 0) {
    return 'This briefing pack contains no figures. Every figure CivicScope includes in a pack is re-checked against its source at generation time.'
  }
  return (
    `This briefing pack covers ${keys.join(', ')}. ` +
    'Every figure in the pack was re-checked against its source at generation time, ' +
    'and the figures below are shown as published, with their margins of error and sources.'
  )
}

export interface TranscribeRequest {
  audio: ArrayBuffer
  mimeType: string
}
export interface TranscribeResult {
  transcript: string
  confidence: number
}

export interface MuseProvider {
  intent(req: IntentRequest, signal: AbortSignal): Promise<IntentResult>
  explain(req: ExplainRequest, signal: AbortSignal): Promise<ExplainResult>
  briefing(req: BriefingRequest, signal: AbortSignal): Promise<BriefingResult>
  transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult>
}

/** Hermetic fake for local tests. Never calls a network or a live model. */
export function createStubProvider(
  handler: Partial<MuseProvider> = {},
): MuseProvider {
  return {
    async intent() {
      return {
        intent: {
          mode: 'lookup',
          geographies: [],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
      }
    },
    async explain() {
      return { prose: '' }
    },
    async briefing(req: BriefingRequest) {
      return { prose: deterministicBriefingProse(req) }
    },
    async transcribe() {
      return { transcript: '', confidence: 0 }
    },
    ...handler,
  }
}
