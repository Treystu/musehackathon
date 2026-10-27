/**
 * Narrow provider interface. Model calls sit behind these shapes so the
 * post-contest swap (provider swap, not rewrite) stays cheap. Validator,
 * meter, and disclosure import nothing from this file.
 */

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
export interface ExplainResult { prose: string }

export interface BriefingRequest { figureSetId: string }
export interface BriefingResult { prose: string }

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
    async briefing() {
      return { prose: '' }
    },
    async transcribe() {
      return { transcript: '', confidence: 0 }
    },
    ...handler,
  }
}
