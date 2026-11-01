/**
 * PRE-EXISTING (contest port, issue #33): the metric registry in this file
 * (METRIC_DEFS, 15 keys) is pre-existing CivicScope code, not contest-built.
 * Source: Sovereign-Communication/civicscope at 3aa7e10dc59e764a8636aa273d4ff86714a3e782.
 * See docs/contest-port-manifest.md.
 */
/**
 * ACS 5-year housing data, with two access shapes.
 *
 * Every table ID below was verified against the live Census variables API, and
 * two of the original ones were wrong in ways that would have produced
 * confidently incorrect numbers:
 *
 *   - `B25002_002E` is occupied housing units, which is the household count.
 *     `B25001_001E` is total housing units and includes vacant homes.
 *   - `B25035_001E` is "Median YEAR STRUCTURE BUILT", not median home value.
 *     Correct table is `B25077`.
 *
 * Rent burden was originally interpolated from the `B25070` distribution
 * because the burden median was assumed not to exist. It does exist:
 * `B25071_001E` is a published median, which replaces our own arithmetic with
 * the Census Bureau's figure and removes a whole class of dispute.
 *
 * Access shapes:
 *   - `sweepNational` — every ZCTA in one request, for screening and filtering
 *   - `fetchArea`    — one or more specific ZCTAs, for drilldown
 *
 * The 5-year sample is used over the 1-year deliberately: it exists for every
 * geography including tracts, and its wider margins of error are surfaced to
 * the user rather than hidden.
 */

import { fetchCached } from '../executor'
import type { AbsentReason, MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

const DATASET = 'acs/acs5'
export const VINTAGE = '2023'

/** ACS variable identifiers, each verified against the live variables API. */
export const VARS = {
  /** Median gross rent, in dollars. */
  medianGrossRent: 'B25064_001E',
  medianGrossRentMoe: 'B25064_001M',
  /** Median value of owner-occupied units, in dollars. B25077, not B25035. */
  medianHomeValue: 'B25077_001E',
  medianHomeValueMoe: 'B25077_001M',
  /** Median household income, inflation-adjusted to the survey year. */
  medianHouseholdIncome: 'B19013_001E',
  medianHouseholdIncomeMoe: 'B19013_001M',
  /** Median gross rent as a share of household income. B25071, published. */
  medianRentBurden: 'B25071_001E',
  medianRentBurdenMoe: 'B25071_001M',
  /**
   * Households, meaning occupied housing units. B25002_002, not B25001: an
   * earlier comment here claimed "B25001, not B25002" with total confidence,
   * and B25001 is total housing units including vacant. It added up perfectly
   * and read as households — for 69201, owner 995 + renter 626 + vacant 465 =
   * 2,086, which was displayed as "Households" with a note saying "all
   * occupied housing units" while 465 of them were empty. Found 2026-10-09 by
   * a reader who compared the map's figure against the drilldown and by
   * checking the publisher's own variable definitions, which is how all four
   * mislabels in this batch were found.
   */
  households: 'B25002_002E',
  householdsMoe: 'B25002_002M',
  /**
   * Workers aged 16 and over who did not work at home — the commuting
   * universe, from the publisher's travel-time table.
   *
   * Two earlier drafts of this variable were both wrong in different
   * directions, and the record deserves both: the original requested
   * B08301_001E under the name "commutingWorkers", which is the count of all
   * workers — a headcount that would have rendered as "36 minutes". A
   * correction on 2026-10-08 swapped it to B08303_001E believing that was the
   * published mean; it is not — the group definition shows B08303 is travel-
   * time *bands* with _001E as the commuting-worker total, so Valentine NE
   * rendered 1,861 "minutes". The publisher publishes no mean at all in this
   * table family: a mean would be our division of aggregate minutes by this
   * count, and this app shows published figures. The metric is therefore what
   * the column actually is, labelled as such.
   */
  commutingWorkers: 'B08303_001E',
  /**
   * Households the Census Bureau classifies as having no internet access at
   * all. B28002_013 — an earlier version requested B28002_003 under the name
   * "noBroadband", which is "dial-up with no other type of internet
   * subscription": a real category, but a handful of households in a typical
   * area rather than the households with nothing at all that the label
   * promised, which is why it read 0 almost everywhere it appeared.
   */
  noInternetAccess: 'B28002_013E',
  /** Renter-occupied units. */
  renterOccupied: 'B25003_003E',
  ownerOccupied: 'B25003_002E',
  /** Total population. */
  population: 'B01003_001E',
  vacantUnits: 'B25002_003E',
  /** Average household size, published directly. B25010_001. */
  averageHouseholdSize: 'B25010_001E',
  /** Median age in years. */
  medianAge: 'B01002_001E',
  /**
   * People whose income in the past 12 months was below the poverty level.
   * B17001_002 is a count, not a rate — an earlier draft named it "povertyRate"
   * and never divided by anything, so the label would have been a lie with a
   * real number in it. The count is what the publisher publishes.
   */
  belowPovertyCount: 'B17001_002E',
  /**
   * Adults whose highest attainment is a bachelor's degree. B15003_022 — an
   * earlier draft requested B15003_003, which is a high-school diploma, under
   * the name "bachelorsOrHigher": the wrong column fetched, named after a
   * category it does not measure. Neither the wrong variable nor the "or higher"
   * sum is published as a single figure; this is the bachelor's count alone,
   * labelled exactly.
   */
  bachelorsCount: 'B15003_022E',
} as const

const TABLE_OF: Record<string, string> = {
  medianGrossRent: 'B25064',
  medianHomeValue: 'B25077',
  medianHouseholdIncome: 'B19013',
  medianRentBurden: 'B25071',
  households: 'B25002',
  renterOccupied: 'B25003',
  ownerOccupied: 'B25003',
  population: 'B01003',
  vacantUnits: 'B25002',
  noInternetAccess: 'B28002',
  averageHouseholdSize: 'B25010',
  medianAge: 'B01002',
  belowPovertyCount: 'B17001',
  bachelorsCount: 'B15003',
  commutingWorkers: 'B08303',
}

/** The Census table a metric key comes from, for the methodology dictionary. */
export function tableOfMetric(key: string): string | null {
  // metric key → column ID (reverse of METRIC_FOR_VAR) → VARS name (reverse of
  // VARS) → table. TABLE_OF is keyed by VARS name, so both reversals are needed.
  const varId = Object.keys(METRIC_FOR_VAR).find((v) => METRIC_FOR_VAR[v] === key)
  if (!varId) return null
  const varsName = Object.keys(VARS).find((k) => VARS[k as keyof typeof VARS] === varId)
  return varsName ? TABLE_OF[varsName] ?? null : null
}

function source(tableId: string, url: string): SourceRef {
  return {
    publisher: 'U.S. Census Bureau',
    dataset: 'American Community Survey 5-Year Estimates',
    tableId,
    vintage: VINTAGE,
    url,
    citation: `ACS 5-year ${VINTAGE}, table ${tableId}`,
  }
}

/**
 * ACS missing-value sentinels.
 *
 * The Census Bureau does not return null or blank for an absent estimate. It
 * returns a large negative number, documented as:
 *
 *   -666666666  N/A — the estimate is not applicable. Verified live: ZCTA 00786
 *                has no renter households, so median rent burden is N/A and the
 *                API returns -666666666 for it.
 *   -999999999  missing
 *   -888888888  not comparable (disjunct)
 *
 * Ratio tables such as B25071 return the same value with a decimal part, so the
 * comparison is made numerically rather than by string.
 *
 * These must never reach the screen. Displayed as a number, -666666666 renders
 * as "$-666,666,666/mo" and "-666666666%", which is not a placeholder but a
 * confidently wrong figure — the exact failure this project exists to prevent.
 */
/*
 * -333333333 and -222222222 were found by auditing 4,000 real ZIP codes rather
 * than by reading a specification: they appear only on margin-of-error columns
 * (198 and 61 occurrences respectively across those columns), which is why a
 * check that only looked at the estimate columns never saw them. Both mean the
 * margin cannot be computed, so both are absent values rather than figures.
 * Without them they survived into the cache, and the margin formatter hid them
 * by rejecting any negative — which meant the app was relying on a display rule
 * to paper over a parsing gap. A round trip through the map's derived figures
 * would have surfaced one as a value.
 */
/**
 * Each encoding, and what it means. Aimed at the reader rather than at the
 * parser: the cause is the useful part, and all three used to be shown as the
 * same phrase.
 */
export const ACS_SENTINEL_REASONS: Record<number, AbsentReason> = {
  [-666666666]: 'not-applicable',
  [-333333333]: 'not-applicable',
  [-999999999]: 'missing',
  [-888888888]: 'not-comparable',
  [-222222222]: 'too-few-households',
}

const ACS_SENTINELS = new Set([
  -666666666,
  -999999999,
  -888888888,
  -333333333,
  -222222222,
])

/**
 * True when a raw ACS value is one of the missing-value sentinels.
 *
 * Tolerant of surrounding whitespace and trailing separators, because these
 * values arrive as strings from a comma-delimited payload and a stray character
 * is the difference between a null and a confidently wrong number.
 */
export function isAcsSentinel(v: unknown): boolean {
  if (typeof v === 'number') return ACS_SENTINELS.has(v)
  if (typeof v !== 'string') return false
  const n = Number(v.trim().replace(/[,;]$/, ''))
  return Number.isFinite(n) && ACS_SENTINELS.has(n)
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '-') return null
  if (typeof v === 'string') {
    const t = v.trim().replace(/[,;]$/, '')
    if (t === '') return null
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    // A sentinel is an absent estimate, not a number.
    return ACS_SENTINELS.has(n) ? null : n
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return ACS_SENTINELS.has(n) ? null : n
}

/** One row per geography, keyed by metric, for the screening table. */
export interface AreaRow {
  zcta: string
  name: string
  metrics: Record<string, number | null>
  moes: Record<string, number | null>
  /**
   * Why each figure is absent, where the publisher said why.
   *
   * Present so the interface can answer honestly instead of showing one phrase
   * for every kind of absence. An audit of the whole country found all of it
   * comes from "not applicable", which is a fact about the place rather than a
   * gap in the data, and "not yet imported" implies the opposite.
   */
  absent?: Record<string, AbsentReason>
}

const METRIC_DEFS: {
  key: string
  label: string
  unit: MetricValue['unit']
  category: MetricValue['category']
  betterWhen: 'higher' | 'lower'
  note: string
}[] = [
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
 * Variables requested for the country-wide screen.
 *
 * Measured against the live API, because the obvious implementation is
 * unusably slow. A single wildcard query covering all 33,791 ZCTAs costs:
 *
 *   1 variable    ~20s
 *   4 variables   ~21s
 *  14 variables   ~65s   ← what this originally requested
 *
 * Fetch and parse are not the problem: parsing 3.9MB takes 24ms and mapping
 * 33k rows takes 10ms. The time is server-side in the Census API, and it grows
 * with the variable count.
 *
 * So the screen loads in two stages. The first request carries the figures the
 * screening table and the map display, together with their margins of error.
 *
 * The margins used to be excluded on grounds of latency, citing a measurement
 * of about 21s at four variables against about 65s at fourteen. That
 * measurement was against the ZIP *wildcard* query, which is not what this app
 * issues. Re-measured on the real chunked path, a chunk with five estimates
 * took 0.45s and the same chunk with five estimates and five margins took
 * 0.47s, because the cost is the 800 rows rather than the column count. Across
 * 43 chunks that is a difference of about a second in total, so there was never
 * a real trade-off and the country-wide screen now shows every figure with the
 * margin the publisher supplies.
 *
 * The remaining variables are fetched only for a selected area.
 */
export const SCREEN_VARS = [
  // The five figures the screening table and the map are built around, each
  // with its margin of error.
  VARS.medianGrossRent,
  VARS.medianGrossRentMoe,
  VARS.medianRentBurden,
  VARS.medianRentBurdenMoe,
  VARS.medianHomeValue,
  VARS.medianHomeValueMoe,
  VARS.medianHouseholdIncome,
  VARS.medianHouseholdIncomeMoe,
  VARS.households,
  VARS.householdsMoe,
  // Ten more, so the national screen carries the context a person deciding
  // where to live actually asks about: whether anyone is there at all, who
  // owns versus rents, whether there is broadband, how crowded a home is, how
  // old people are, whether income is below the poverty line, how much
  // education, and how long the commute is.
  //
  // Measured, not assumed: 20 variables over an 800-ZCTA chunk is a 6,770
  // character URL, returns all 800 rows, and takes 3.9s. The earlier claim that
  // extra columns were free held at ten variables and does not hold at twenty;
  // a cold national sweep therefore takes about three minutes rather than one.
  // It is cached, so a returning visit spends nothing.
  VARS.population,
  VARS.ownerOccupied,
  VARS.renterOccupied,
  VARS.vacantUnits,
  VARS.noInternetAccess,
  VARS.averageHouseholdSize,
  VARS.medianAge,
  VARS.belowPovertyCount,
  VARS.bachelorsCount,
  VARS.commutingWorkers,
]

/** Everything else, fetched only for a selected area. Exported for the completeness test. */
export const DETAIL_VARS = [
  VARS.medianGrossRent,
  VARS.medianGrossRentMoe,
  VARS.medianHomeValue,
  VARS.medianHomeValueMoe,
  VARS.medianHouseholdIncome,
  VARS.medianHouseholdIncomeMoe,
  VARS.medianRentBurden,
  VARS.medianRentBurdenMoe,
  VARS.households,
  // Households, population and the owner/renter split were fetched for the
  // detail view without their published margins, so the drilldown showed them
  // as bare point estimates — the one presentation this app exists to avoid.
  // Found by the "every detail estimate that has a published margin requests
  // it" test in tests/metric-registry.test.ts, which then failed on the four
  // figures that predate it.
  'B25002_002M',
  VARS.population,
  'B01003_001M',
  VARS.renterOccupied,
  'B25003_003M',
  VARS.ownerOccupied,
  'B25003_002M',
  VARS.vacantUnits,
  'B25002_003M',
  VARS.noInternetAccess,
  'B28002_013M',
  VARS.averageHouseholdSize,
  VARS.averageHouseholdSize.replace(/E$/, 'M'),
  VARS.medianAge,
  VARS.medianAge.replace(/E$/, 'M'),
  VARS.belowPovertyCount,
  'B17001_002M',
  VARS.bachelorsCount,
  'B15003_022M',
  VARS.commutingWorkers,
  VARS.commutingWorkers.replace(/E$/, 'M'),
]

/** Maps an ACS variable to the metric key the UI uses. Exported for the completeness test. */
export const METRIC_FOR_VAR: Record<string, string> = {
  [VARS.medianGrossRent]: 'median_gross_rent',
  [VARS.medianHomeValue]: 'median_home_value',
  [VARS.medianHouseholdIncome]: 'median_household_income',
  [VARS.medianRentBurden]: 'median_rent_burden_pct',
  [VARS.households]: 'households',
  [VARS.population]: 'population',
  [VARS.renterOccupied]: 'renter_occupied',
  [VARS.ownerOccupied]: 'owner_occupied',
  [VARS.vacantUnits]: 'vacant_units',
  [VARS.noInternetAccess]: 'no_internet_access',
  [VARS.averageHouseholdSize]: 'average_household_size',
  [VARS.medianAge]: 'median_age',
  [VARS.belowPovertyCount]: 'below_poverty_count',
  [VARS.bachelorsCount]: 'bachelors_count',
  [VARS.commutingWorkers]: 'commuting_workers',
}

/**
 * Rejects any value that is not a plausible measurement, regardless of where
 * it came from.
 *
 * This exists because a cache hit bypasses the parser entirely. Rows cached
 * before the sentinel fix was shipped still hold -666666666 as a real number
 * under the same version stamp, so they were replayed straight into the table
 * and rendered as -666666666% and -$666,666,666. Version stamping alone did not
 * clear them, because the stamp was not changed when the parser changed.
 *
 * So every value that came out of storage is passed through this before use. A
 * negative number is never a valid figure from any of these tables, and a rate
 * above 100 percent is not either, so anything failing those is treated as
 * absent. This makes the guarantee independent of cache contents and of which
 * build wrote them.
 */
export function sanitiseMetricValue(value: unknown, unit?: string): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  if (isAcsSentinel(n)) return null
  // No ACS estimate in this set is negative. A negative value can only be a
  // missing-value encoding that slipped through, so it is treated as absent
  // rather than displayed.
  if (n < 0) return null
  if (unit === 'percent' && n > 100) return null
  return n
}

/** Applies sanitisation to a whole cached row. */
export function sanitiseAreaRow(row: AreaRow): AreaRow {
  const metrics: AreaRow['metrics'] = {}
  for (const [key, value] of Object.entries(row.metrics ?? {})) {
    const unit = key === 'median_rent_burden_pct' ? 'percent' : undefined
    const clean = sanitiseMetricValue(value, unit)
    if (clean !== null) metrics[key] = clean
  }
  const moes: AreaRow['moes'] = {}
  for (const [key, value] of Object.entries(row.moes ?? {})) {
    const clean = sanitiseMetricValue(value)
    if (clean !== null) moes[key] = clean
  }
  return { ...row, metrics, moes }
}

/**
 * Parses a raw ACS response into rows.
 *
 * The geography column position is derived from the returned header rather than
 * assumed, because the sweep and the detail query request different variable
 * sets and the trailing geography column lands in a different position.
 */
export function areaRowFromRaw(header: readonly string[], rows: readonly (readonly (string | number)[])[]): AreaRow[] {
  const col = (name: string): number => header.indexOf(name)
  const nameCol = col('NAME')

  const out: AreaRow[] = []
  const absent: Record<string, AbsentReason> = {}
  for (const row of rows) {
    const label = String(row[nameCol] ?? '')
    const zcta = (label.match(/(\d{5})/) ?? [])[1]
    if (!zcta) continue

    const metrics: AreaRow['metrics'] = {}
    const moes: AreaRow['moes'] = {}
    for (const [varName, key] of Object.entries(METRIC_FOR_VAR)) {
      const i = col(varName)
      if (i >= 0) {
        metrics[key] = toNum(row[i])
        // Record why, where the publisher said why, so the interface can tell
        // "nothing to measure here" apart from "we did not load it".
        if (metrics[key] === null && i < row.length) {
          const raw = Number(row[i])
          const reason = ACS_SENTINEL_REASONS[raw]
          if (reason) absent[key] = reason
        }
      }
      // The margin column is the estimate's ID with E replaced by M. An earlier
      // version derived it as _001E -> _001M, which only matches the first
      // estimate of a table — so for B25002_003E (vacant units) it produced the
      // estimate's own column ID, and the drilldown would have shown each of
      // those figures as its own margin of error. Found while verifying the
      // seven figures before they shipped, before a single reader saw it.
      const m = col(varName.replace(/E$/, 'M'))
      if (m >= 0) {
        const v = toNum(row[m])
        if (v !== null) moes[key] = v
      }
    }
    out.push({ zcta, name: label.trim() || `ZCTA5 ${zcta}`, metrics, moes, absent })
  }
  return out
}

/** One or more specific ZCTAs, for drilldown on a chosen area. */
export async function fetchAreas(
  zctas: readonly string[],
  censusKey: string,
  signal: AbortSignal,
): Promise<AreaRow[]> {
  if (zctas.length === 0) return []

  // Same limit as the sweep: the Census API rejects an over-long geography
  // string with a 400, and the limit is on URL length rather than row count.
  if (zctas.length > 800) {
    throw new Error(`a drilldown may not request more than 800 ZIP codes at once (got ${zctas.length})`)
  }

  // Unquoted, comma-separated. Quoting returns HTTP 400 from the Census API.
  const url =
    `https://api.census.gov/data/${VINTAGE}/${DATASET}` +
    `?get=NAME,${DETAIL_VARS.join(',')}` +
    `&for=${encodeURIComponent(`zip code tabulation area:${zctas.join(',')}`)}` +
    `&key=${encodeURIComponent(censusKey)}`

  const { body } = await fetchCached<unknown[]>(url, signal, 30 * 24 * 60 * 60 * 1000)

  // Shape validation, not status: the API answers HTTP 200 with an HTML error
  // page for a missing or invalid key.
  if (!Array.isArray(body) || !Array.isArray(body[0])) return []
  const header = (body[0] as unknown[]).map(String)
  const rows: (string | number)[][] = []
  for (let i = 1; i < body.length; i++) {
    const r = body[i]
    if (Array.isArray(r)) rows.push(r.map((c) => (c === null ? '' : String(c))))
  }
  return areaRowFromRaw(header, rows)
}

/** Converts a swept row into the standard metric shape for display. */
export function rowToMetrics(row: AreaRow): MetricValue[] {
  const out: MetricValue[] = []
  for (const def of METRIC_DEFS) {
    const value = row.metrics[def.key] ?? null
    const moe = row.moes[def.key] ?? undefined
    out.push({
      key: def.key,
      label: def.label,
      value,
      absentReason: value === null ? (row.absent?.[def.key] ?? 'missing') : undefined,
      unit: def.unit,
      category: def.category,
      source: source(TABLE_OF[def.key] ?? 'ACS', `https://api.census.gov/data/${VINTAGE}/${DATASET}`),
      quality: { marginOfError: moe ?? undefined },
      betterWhen: def.betterWhen,
      note: def.note,
    })
  }
  return out
}

export const acsHousingPlugin: PluginRequest = {
  id: 'acs-housing',
  title: 'Housing cost and demographics (ACS)',
  category: 'cost',
  geography: 'zip',
  minZoom: 2,
  requiresCensusKey: true,
  legal: {
    suppressBelow: 20,
    notice:
      'ACS 5-year estimates carry a margin of error, shown beside every figure. Small areas are less reliable than large ones.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const zip = ctx.geo?.zip
    if (!zip) return []
    const rows = await fetchAreas([zip], ctx.censusKey!, ctx.signal)
    const row = rows.find((r) => r.zcta === zip)
    return row ? rowToMetrics(row) : []
  },
}


