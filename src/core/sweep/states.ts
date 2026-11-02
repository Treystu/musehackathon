/**
 * State selection for the country-wide screen.
 *
 * The screen answers "which ZIP codes are affordable" for the whole country, but
 * a visitor who has narrowed to a region should not pay for 34 chunks when three
 * would do. Selecting states partitions the sweep before it starts, which is the
 * difference between a two-second wait and a two-minute one.
 *
 * The partitions are built from the place index — each ZCTA's own state, from
 * the Census ZCTA-to-place/county relationships — so a state appears exactly
 * when it has ZIP codes, with the ZIP prefixes the sweep's chunk loader needs.
 * An earlier version derived the list from two-digit prefixes labelled by a
 * table keyed on state FIPS codes: the labels were wrong for most prefixes,
 * Colorado's own prefixes never appeared at all, and nothing in the app ever
 * loaded the list, so the filter rendered empty and no selection was possible.
 */

import { stateName } from './chunk'

/** Postal code -> state name, for the codes the place index can produce. */
export const STATE_NAME_BY_CODE: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AS: 'American Samoa', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', GU: 'Guam', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  MP: 'Northern Mariana Islands', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VI: 'Virgin Islands', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

/** One state's share of the country: its ZCTAs and the prefixes they span. */
export interface StatePartition {
  /** Postal code, e.g. `CO`. */
  code: string
  /** Display name, e.g. `Colorado`. */
  label: string
  /** Two-digit ZIP prefixes this state's ZCTAs span, ascending. */
  prefixes: string[]
  /** The state's ZCTAs, ascending. */
  zctas: string[]
}

/**
 * Partition the national ZCTA list by each ZCTA's own state.
 *
 * `stateByZip` comes from the place index and covers every enumerated ZCTA
 * (the county fallback record leaves none stateless). A ZCTA missing from it
 * falls back to its prefix's majority state within the same pass, so a gap in
 * the index can never silently drop a ZIP from every state.
 */
export function buildStatePartitions(
  zctas: readonly string[],
  stateByZip: ReadonlyMap<string, string>,
): StatePartition[] {
  const prefixMajority = new Map<string, string>()
  {
    const tally = new Map<string, Map<string, number>>()
    for (const z of zctas) {
      const state = stateByZip.get(z)
      if (!state) continue
      const p = z.slice(0, 2)
      const byState = tally.get(p) ?? new Map<string, number>()
      byState.set(state, (byState.get(state) ?? 0) + 1)
      tally.set(p, byState)
    }
    for (const [p, byState] of tally) {
      prefixMajority.set(p, [...byState.entries()].sort((a, b) => b[1] - a[1])[0]![0])
    }
  }
  const byState = new Map<string, string[]>()
  for (const z of zctas) {
    const state = stateByZip.get(z) ?? prefixMajority.get(z.slice(0, 2))
    if (!state) continue
    const list = byState.get(state) ?? []
    list.push(z)
    byState.set(state, list)
  }
  return [...byState.entries()]
    .map(([code, list]) => ({
      code,
      label: STATE_NAME_BY_CODE[code] ?? code,
      prefixes: [...new Set(list.map((z) => z.slice(0, 2)))].sort(),
      zctas: [...list].sort(),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export interface StateOption {
  /** Postal code, e.g. `CO`. */
  code: string
  /** Display name, e.g. `Colorado`. */
  label: string
  /** How many ZCTAs the state has in the enumeration. */
  count: number
  /** Two-digit ZIP prefixes selecting this state loads. */
  prefixes: string[]
}

export function stateOptions(partitions: readonly StatePartition[]): StateOption[] {
  return partitions.map((p) => ({
    code: p.code,
    label: p.label,
    count: p.zctas.length,
    prefixes: p.prefixes,
  }))
}

/**
 * Toggles a whole state in a prefix selection: all of the state's prefixes
 * arrive or leave together, so a selection built by clicking can always be
 * named as a set of states. Additions preserve click order.
 */
export function toggleStateOption(
  current: readonly string[],
  option: Pick<StateOption, 'prefixes'>,
): string[] {
  const allIn = option.prefixes.every((p) => current.includes(p))
  if (allIn) return current.filter((p) => !option.prefixes.includes(p))
  return [...current, ...option.prefixes.filter((p) => !current.includes(p))]
}

/**
 * The ZIP prefixes an Ask geography resolves to, from the place index: every
 * prefix spanned by places in the named states. This is the seam the Ask
 * sweep scope runs through, so it is a pure function with the index as an
 * argument — the derivation is testable against the real payload rather than
 * only by driving the UI.
 */
export function scopePrefixesForStates(
  places: readonly { state: string; zips: readonly string[] }[],
  namedStates: readonly string[],
): string[] {
  const found = new Set<string>()
  for (const place of places) {
    if (!namedStates.includes(place.state)) continue
    for (const zip of place.zips) found.add(zip.slice(0, 2))
  }
  return [...found].sort()
}

/**
 * How many chunks a scope will cost, so the UI can be honest about the wait
 * before it starts rather than discovering it halfway through.
 */
export function estimateChunks(zctasInScope: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(zctasInScope / chunkSize))
}

/**
 * Human label for a prefix selection, matching the phrasing used in the
 * loading copy. When the selection is exactly some whole states (the only
 * kind the filter builds), they are named as states; anything else falls
 * back to the prefix label of its first member.
 */
export function describeScope(
  selected: readonly string[],
  partitions?: readonly StatePartition[],
): string {
  if (selected.length === 0) return 'the United States'
  if (partitions) {
    const whole = partitions.filter(
      (p) => p.prefixes.length > 0 && p.prefixes.every((x) => selected.includes(x)),
    )
    const covered = new Set(whole.flatMap((p) => p.prefixes))
    if (whole.length > 0 && covered.size === selected.length) {
      if (whole.length === 1) return whole[0]!.label
      return `${whole.length} states`
    }
  }
  if (selected.length === 1) return stateName(selected[0]!)
  return `${selected.length} states`
}
