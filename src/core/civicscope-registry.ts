/**
 * PRE-EXISTING port — not contest-built.
 * Source: public Sovereign-Communication/civicscope @ 3aa7e10dc59e764a8636aa273d4ff86714a3e782
 * (src/core/plugins/acs.ts lines 250-383; src/core/types.ts lines 33-50;
 *  src/core/sortable-surface.ts lines 38-64).
 *
 * Minimal registry surface only: the 15-key METRIC_DEFS with field
 * annotations (unit/category/betterWhen), METRIC_DEFS_BY_KEY, METRIC_KEYS,
 * and the 5-key SORTABLE_METRIC_KEYS with its guard. Two mechanical,
 * value-preserving adaptations (see docs/registry-port.md):
 *   - METRIC_DEFS is exported here (non-exported const in source) so the
 *     workbench can consume it as the single source of truth.
 *   - The inline anonymous row type is named MetricDef, with
 *     MetricValue['unit'/'category'] spelled as the copied MetricUnit /
 *     MetricCategory unions (byte-identical to source types.ts).
 * NOT ported: VARS/SCREEN_VARS/DETAIL_VARS, fetch paths, sentinel logic,
 * TABLE_OF/tableOfMetric, plugin wiring + legal block, executor, types.
 */

export type MetricCategory =
  | 'cost'
  | 'education'
  | 'demographics'
  | 'health'
  | 'environment'
  | 'labor'

/**
 * 'institutions' counts organisations, not people or households — school
 * buildings, for instance. The distinction is load-bearing: the engine's
 * minimum-n suppression exists so a reader cannot over-read a figure about a
 * handful of *people*, and a district with 3 schools is an exact administrative
 * fact the publisher publishes, not a small-sample estimate. Before this unit
 * existed, "Schools in district: 3" was suppressed to "not published" by a rule
 * that was never meant for it.
 */
export type MetricUnit = 'usd' | 'usd_monthly' | 'percent' | 'ratio' | 'number' | 'count' | 'index' | 'institutions'

/** One row of the ported metric registry. Shape matches the inline
 * annotation on METRIC_DEFS in source acs.ts; named here for reuse.
 */
export interface MetricDef {
  key: string
  label: string
  unit: MetricUnit
  category: MetricCategory
  betterWhen: 'higher' | 'lower'
  note: string
}

export const METRIC_DEFS: MetricDef[] = [
  {
    key: 'median_gross_rent',
    label: 'Median gross rent',
    unit: 'usd_monthly',
    category: 'cost',
    betterWhen: 'lower',
    note: 'Gross rent includes utilities, so it runs above the advertised rent a listing would show.',
  },
  {
    key: 'median_rent_burden_pct',
    label: 'Median rent as share of income',
    unit: 'percent',
    category: 'cost',
    betterWhen: 'lower',
    note: 'Published by the Census Bureau, not calculated here. Above 30% is conventionally a housing cost burden.',
  },
  {
    key: 'median_home_value',
    label: 'Median home value',
    unit: 'usd',
    category: 'cost',
    betterWhen: 'lower',
    note: 'Value of owner-occupied units only, so areas with few owners may have no figure.',
  },
  {
    key: 'median_household_income',
    label: 'Median household income',
    unit: 'usd',
    category: 'cost',
    betterWhen: 'higher',
    note: 'Household income for the most recent 12 months, adjusted for inflation.',
  },
  {
    key: 'households',
    label: 'Households',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'lower',
    note: 'Occupied housing units, owner and renter alike. Until 2026-10-09 this was the total housing units of the area, vacant homes included, under this same label — for ZIP 69201 that read as 2,086 households while 465 of the units were empty.',
  },
  {
    key: 'population',
    label: 'Population',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'lower',
    note: 'Resident population.',
  },
  {
    key: 'renter_occupied',
    label: 'Renter-occupied units',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'lower',
    note: 'Units occupied by renters.',
  },
  {
    key: 'owner_occupied',
    label: 'Owner-occupied units',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'higher',
    note: 'Units occupied by their owners. Fetched and mapped since the screen first shipped, but missing from this registry until a completeness test was written for it on 2026-10-08 — until then the figure was fetched and never displayed.',
  },
  {
    key: 'vacant_units',
    label: 'Vacant units',
    unit: 'count',
    category: 'cost',
    betterWhen: 'lower',
    note: 'Housing units with nobody living in them, of any kind: for sale, for rent, seasonal or otherwise. A high count can mean a resort town as easily as abandonment.',
  },
  {
    key: 'no_internet_access',
    label: 'Households with no internet access',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'lower',
    note: 'Households the Census Bureau classifies as having no internet access at all — no subscription and no access. Until 2026-10-09 this figure was the count of households whose only internet was dial-up, a much smaller category, under a label that promised the larger one.',
  },
  {
    key: 'average_household_size',
    label: 'Average household size',
    unit: 'ratio',
    category: 'demographics',
    betterWhen: 'higher',
    note: 'The average number of people per household, published directly by the Census Bureau.',
  },
  {
    key: 'median_age',
    label: 'Median age',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'higher',
    note: 'Age in years, as published. Shown for reading; never offered as a sort or filter control, because ordering places by the age of the people in them is not a question this tool will answer for you.',
  },
  {
    key: 'below_poverty_count',
    label: 'People below the poverty line',
    unit: 'count',
    category: 'demographics',
    betterWhen: 'lower',
    note: 'People whose income in the past 12 months was below the federal poverty level. A count of people, not a share — compare it against population to read it.',
  },
  {
    key: 'bachelors_count',
    label: 'Adults with a bachelor\u2019s degree',
    unit: 'count',
    category: 'education',
    betterWhen: 'higher',
    note: 'People aged 25 and over whose highest attainment is a bachelor\u2019s degree. Degrees above bachelor\u2019s are not included; the publisher has no single column for them.',
  },
  {
    key: 'commuting_workers',
    label: 'Commuting workers',
    unit: 'count',
    category: 'labor',
    betterWhen: 'higher',
    note: 'Workers aged 16 and over who did not work from home — the people the Census Bureau\u2019s commute figures count. The publisher has no single figure for mean commute time at this geography; computing one would be our division of two of their columns, so this shows the published count instead.',
  },
]

export const METRIC_DEFS_BY_KEY = new Map(METRIC_DEFS.map((d) => [d.key, d]))

/** Every metric key this plugin can produce, in registry order. */
export const METRIC_KEYS: readonly string[] = METRIC_DEFS.map((d) => d.key)

/**
 * The housing figures a reader may sort the country by.
 *
 * Deliberately narrow. `median_household_income` is included with the Fair
 * Housing notice beside it, per the recorded decision that income is retained
 * with disclosure rather than excluded; it correlates with protected classes
 * without encoding one.
 *
 * Everything the ACS screen loads but this list omits — population, age, poverty
 * rate, educational attainment, broadband, crowding — is display-only. Several
 * of those are the demographic figures the rule exists to keep out of a ranking
 * control, and their absence here is the rule working.
 */
export const SORTABLE_METRIC_KEYS = [
  'median_rent_burden_pct',
  'median_gross_rent',
  'median_home_value',
  'median_household_income',
  'households',
] as const

export type SortableMetricKey = (typeof SORTABLE_METRIC_KEYS)[number]

/** Every allowlisted key must exist in the ACS housing definitions. */
export function isSortableMetricKey(key: string): key is SortableMetricKey {
  return (SORTABLE_METRIC_KEYS as readonly string[]).includes(key) && METRIC_DEFS_BY_KEY.has(key)
}
