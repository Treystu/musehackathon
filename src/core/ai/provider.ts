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
  values: {
    key: string
    value: number | null
    marginOfError?: number
    /**
     * Display name of the place the figure belongs to, when the view
     * knows it. The explain prompt names places by label so the prose
     * can attribute figures to places; a raw ZIP never enters the
     * prompt (it is a numeral the figure validator cannot tell apart
     * from an invented figure — the same rule the briefing path
     * follows, found live 2026-11-01; explain carried no labels at
     * all before 2026-11-02, so its prose could not attribute a
     * figure to its place).
     */
    label?: string
  }[]
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
  values: {
    key: string
    value: number | null
    marginOfError?: number
    /**
     * The place the figure belongs to, when the set spans places. Two
     * places share metric keys legitimately; geography is what tells
     * their figures apart (without it a multi-place pack was refused
     * as "duplicate figure key" — found live 2026-11-01).
     */
    geography?: string
    /** Display name for the place, when known; prompts name places by
     * label so a ZIP numeral never enters the model's context (the
     * figure validator cannot tell one from an invented figure). */
    label?: string
  }[]
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

/**
 * Grounded web research (2026-11-01, owner directive: any question
 * answerable). The Census data cannot serve criteria like schools,
 * amenities, or political character; those go to the Muse Responses
 * API's web_search tool and come back as prose WITH citations. The
 * citation list is part of the result contract: prose without sources
 * is not a research result and is never presented as one.
 */
export interface ResearchRequest {
  queryText: string
  /** Places the question names, when the parse found any. */
  places?: string[]
}

export interface ResearchSource {
  title: string
  url: string
}

export interface ResearchResult {
  prose: string
  sources: ResearchSource[]
}

export interface MuseProvider {
  intent(req: IntentRequest, signal: AbortSignal): Promise<IntentResult>
  explain(req: ExplainRequest, signal: AbortSignal): Promise<ExplainResult>
  briefing(req: BriefingRequest, signal: AbortSignal): Promise<BriefingResult>
  transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult>
  research(req: ResearchRequest, signal: AbortSignal): Promise<ResearchResult>
}

/**
 * One stage-scoped chat completion with a per-call model selection
 * (conversational stack C1, 2026-11-02). The hourglass bookends are
 * single-purpose stages that do not fit the intent/explain/briefing
 * shapes: they take a system instruction plus one condensed packet
 * and return raw text the caller parses under a closed verdict
 * schema. Kept as a separate interface so the replay and golden
 * providers, which implement MuseProvider as object literals, are
 * not forced to grow a stage they can never serve honestly.
 */
export interface StageChatRequest {
  /** Stage model for this call; absent means the provider default. */
  model?: string
  system: string
  user: string
}

export interface StageChatResult {
  text: string
  /** The model id the provider reports for the call, when it does. */
  model: string
}

export interface StageChatProvider {
  stageChat(req: StageChatRequest, signal: AbortSignal): Promise<StageChatResult>
}

/** Hermetic stage fake: answers only what the handler supplies. */
export function createStubStageProvider(
  handler: Partial<StageChatProvider> = {},
): StageChatProvider {
  return {
    async stageChat() {
      return { text: '', model: 'stub' }
    },
    ...handler,
  }
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
    async research() {
      return { prose: '', sources: [] }
    },
    ...handler,
  }
}
