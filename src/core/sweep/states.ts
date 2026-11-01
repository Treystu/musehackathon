/**
 * State selection for the country-wide screen.
 *
 * The screen answers "which ZIP codes are affordable" for the whole country, but
 * a visitor who has narrowed to a region should not pay for 34 chunks when three
 * would do. Selecting states partitions the sweep before it starts, which is the
 * difference between a two-second wait and a two-minute one.
 *
 * The list is derived from the ZCTA prefixes themselves rather than hardcoded, so
 * a state appears exactly when it has ZIP codes, and no state can be missing
 * because someone forgot to add it.
 */

import { stateName, type ZctasByPrefix } from './chunk'

export interface StateOption {
  /** Two-digit USPS prefix. */
  code: string
  label: string
  count: number
}

export function stateOptions(groups: readonly ZctasByPrefix[]): StateOption[] {
  return groups
    .map((g) => ({ code: g.zip, label: stateName(g.zip), count: g.zctas.length }))
    .filter((o) => o.label && !o.label.startsWith('ZIP prefix'))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Toggles a state in the selection, preserving the order the user clicked so
 * the scope label reads the way they chose it.
 */
export function toggleState(current: readonly string[], code: string): string[] {
  return current.includes(code) ? current.filter((c) => c !== code) : [...current, code]
}

/**
 * How many chunks a scope will cost, so the UI can be honest about the wait
 * before it starts rather than discovering it halfway through.
 */
export function estimateChunks(zctasInScope: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(zctasInScope / chunkSize))
}

/** Human label for a selection, matching the phrasing used in the loading copy. */
export function describeScope(selected: readonly string[]): string {
  if (selected.length === 0) return 'the United States'
  if (selected.length === 1) return stateName(selected[0]!)
  return `${selected.length} states`
}
