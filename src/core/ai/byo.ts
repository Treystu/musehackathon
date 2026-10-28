/**
 * BYO (Bring Your Own Meta key) routing — placement DECIDED (owner, Oct 27):
 * shared-only on the happy path. BYO is offered on shutoff/error and in
 * settings only — never as a hero element on the Ask surface itself.
 * BYO spend is the visitor's own, never the shared $150.
 */
import type { ProxyError } from './proxy-errors'

export type AskPath = 'shared' | 'byo' | 'unavailable'

/** Errors after which offering BYO is appropriate (settings/shutoff offers). */
export const BYO_OFFER_ERRORS: ReadonlySet<ProxyError> = new Set([
  'budget_exhausted', 'credits_exhausted',
])

export function shouldOfferByo(error: ProxyError | null | undefined): boolean {
  return error != null && BYO_OFFER_ERRORS.has(error)
}

/** Shared first; BYO only beyond the shared allowance. Never required. */
export function decideAskPath(input: {
  budgetExhausted: boolean
  breakerOpen: boolean
  hasByoKey: boolean
}): AskPath {
  if (!input.budgetExhausted && !input.breakerOpen) return 'shared'
  if (input.hasByoKey) return 'byo'
  return 'unavailable'
}
