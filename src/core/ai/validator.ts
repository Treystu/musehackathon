/**
 * Validator interface — pad owns the implementation (single source).
 * At port time this re-exports from the pad path; here a hermetic stub
 * implements the same contract for local tests. Do NOT duplicate the
 * real validator implementation in Entire.
 *
 * Fail-closed 6-step order:
 *  1 pre-generation intent gate
 *  2 allowed-numeral set
 *  3 numeral scan (incl. closed word-form table)
 *  4 provenance match
 *  5 precision / MOE-CI overlap
 *  6 constructions + disposition (withhold + figures + note)
 */

export interface FigureForValidation {
  key: string
  value: number | null
  marginOfError?: number
  vintage?: string
}

export type ValidatorFailure =
  | 'intent_gate'
  | 'invented_numeral'
  | 'precision'
  | 'banned_construction'

export type ValidatorVerdict =
  | { pass: true }
  | { pass: false; failure: ValidatorFailure; detail: string }

export interface Validator {
  validate(prose: string, figures: FigureForValidation[]): ValidatorVerdict
}

/** Hermetic stub: passes empty prose, withholds anything with a digit. */
export const hermeticStubValidator: Validator = {
  validate(prose) {
    if (!prose.trim()) return { pass: true }
    if (/\d/.test(prose)) {
      return { pass: false, failure: 'invented_numeral', detail: 'stub withholds digit prose' }
    }
    return { pass: true }
  },
}

export const DISCLOSURE_TEXT =
  "Figures are CivicScope's (source and vintage shown with each figure). Wording is Muse Spark's. This is a reading of the shown figures, not an additional source."
