/**
 * Explain on every view (plan section 1: Explain on all views).
 *
 * Client-side host for the provider's explain shape, generalized from
 * the Ask surface. Any view's figure set — drilldown, comparison,
 * sweep, map selection, saved view, similarity — can request an
 * explanation through the same provider + validator plumbing Ask uses
 * (provider.explain, then the fail-closed numeral-provenance
 * validator). A failed verdict or a provider error returns a
 * withholding, never the raw prose.
 */
import type { ExplainRequest, MuseProvider } from './provider'
import type {
  FigureForValidation,
  Validator,
  ValidatorFailure,
} from './validator'

/** The six Explain classes named in the plan (section 6.2.3 classes). */
export const EXPLAIN_VIEW_CLASSES = [
  'drilldown',
  'comparison',
  'sweep',
  'map_selection',
  'saved_view',
  'similarity',
] as const

export type ExplainViewClass = (typeof EXPLAIN_VIEW_CLASSES)[number]

export const EXPLAIN_VIEW_LABELS: Record<ExplainViewClass, string> = {
  drilldown: 'Drilldown',
  comparison: 'Comparison',
  sweep: 'Sweep',
  map_selection: 'Map selection',
  saved_view: 'Saved view',
  similarity: 'Similarity',
}

/** The figure shape every view already renders (FigureInput-compatible). */
export interface ViewFigureForExplain {
  key: string
  value: number | null
  marginOfError?: number
  vintage?: string
  /** Display name of the figure's place, when the view knows it; the
   * explain prompt names places by label so prose can attribute
   * figures to places (never a raw ZIP — see ExplainRequest). */
  label?: string
}

export interface ViewExplanation {
  prose: string | null
  withheld: boolean
  /** Withholding class when withheld; absent on a pass. */
  failure?: ValidatorFailure | 'provider_error'
}

/** The explain route caps figureSetId at 128 chars; stay inside it. */
const MAX_FIGURE_SET_ID_CHARS = 128

export function figureSetIdForView(
  viewClass: ExplainViewClass,
  figures: readonly ViewFigureForExplain[],
): string {
  const id = `${viewClass}:${figures.map((f) => f.key).join('+')}`
  return id.length <= MAX_FIGURE_SET_ID_CHARS
    ? id
    : id.slice(0, MAX_FIGURE_SET_ID_CHARS)
}

/** Build the provider request for a view's figure set. */
export function explainRequestForView(
  viewClass: ExplainViewClass,
  figures: readonly ViewFigureForExplain[],
): ExplainRequest {
  return {
    figureSetId: figureSetIdForView(viewClass, figures),
    values: figures.map((f) => ({
      key: f.key,
      value: f.value,
      marginOfError: f.marginOfError,
      label: f.label,
    })),
  }
}

/**
 * Request an explanation for one view's figure set and gate the prose
 * through the validator before anyone renders it. Fail-closed in every
 * failure mode: provider error, non-string prose, or a failed verdict
 * all come back as a withholding with the prose dropped.
 */
export async function explainView(
  provider: MuseProvider,
  validator: Validator,
  viewClass: ExplainViewClass,
  figures: readonly ViewFigureForExplain[],
  signal: AbortSignal = new AbortController().signal,
): Promise<ViewExplanation> {
  let prose: unknown
  try {
    const result = await provider.explain(
      explainRequestForView(viewClass, figures),
      signal,
    )
    prose = result?.prose
  } catch {
    return { prose: null, withheld: true, failure: 'provider_error' }
  }
  if (typeof prose !== 'string') {
    return { prose: null, withheld: true, failure: 'provider_error' }
  }
  if (prose.trim() === '') return { prose, withheld: false }
  // The figures the view displays are the provenance set: value, MOE,
  // and vintage (the validator admits vintage years from shown figures).
  const verdict = validator.validate(prose, figures as FigureForValidation[])
  if (!verdict.pass) {
    return { prose: null, withheld: true, failure: verdict.failure }
  }
  return { prose, withheld: false }
}
