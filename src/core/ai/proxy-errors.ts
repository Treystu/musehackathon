/**
 * Closed proxy error taxonomy. Core owns the union and its ordered list;
 * the route layer imports them rather than defining them.
 */

export type ProxyError =
  | 'not_allowlisted'
  | 'shape_invalid'
  | 'rate_limited'
  | 'credits_exhausted'
  | 'provider_down'
  | 'bad_key'
  | 'budget_exhausted'
  | 'breaker_open'

export const PROXY_ERRORS: readonly ProxyError[] = [
  'not_allowlisted',
  'shape_invalid',
  'rate_limited',
  'credits_exhausted',
  'provider_down',
  'bad_key',
  'budget_exhausted',
  'breaker_open',
]
