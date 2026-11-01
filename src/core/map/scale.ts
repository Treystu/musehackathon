/**
 * The map's colour scale.
 *
 * Two decisions are load-bearing and both are constraints rather than taste.
 *
 * Colour. A sequential single-hue ramp, not a rainbow. A rainbow ramp invents
 * boundaries that are not in the data and is unreadable to the most common form
 * of colour blindness. The ramp is also used only for magnitude; it is never used
 * to imply that a colour is good or bad, because "high home value" is not a
 * judgement and a map that reads as one is a fair-housing problem.
 *
 * Binning. Quantiles rather than equal intervals, because housing distributions
 * are heavily skewed: a few ZIPs hold extreme values that would flatten the rest
 * of the country into a single step. Quantiles keep the map readable, and the
 * legend prints the real boundaries so nothing is hidden by the binning.
 */

/**
 * A map figure.
 *
 * Most are a single cached ACS column. The rest are *derived*: arithmetic on
 * figures already held, so they cost no extra request and cannot introduce a
 * value the publishers did not supply. They exist because the questions people
 * actually ask when they are moving are not phrased in terms of a single ACS
 * variable. Nobody asks "what is B19013_001E here"; they ask "what can I afford
 * on what I earn", which is a ratio.
 */
export interface MapMetric {
  key: string
  label: string
  unit: string
  /** Which direction reads as the answer to the question. Never a judgement. */
  betterWhen: 'lower' | 'higher'
  /**
   * Present only for derived figures; returns null when it cannot be formed, or
   * when the inputs are too thin to stand behind.
   */
  derive?: (m: Record<string, number | null>) => number | null
  /** One line shown under the selector, saying what the figure is and is not. */
  blurb: string
}

/**
 * The floor for publishing a derived figure at all.
 *
 * It used to be 500 households, on sound reasoning — an ACS median over a few
 * dozen households is dominated by a single family — and it still produced the
 * wrong outcome: it greyed out 438 of 1,412 areas on the price-to-income map, and
 * a reader cannot distinguish "we are withholding this" from "there is nothing
 * here". It was the app's own decision presented as a fact about the place.
 *
 * So the figure is shown wherever it can be computed, and a thin sample is
 * marked rather than hidden. The uncertainty is visible and the data is loaded;
 * neither pretends to be the other.
 */
/**
 * The figures offered on the map, and how each one is derived.
 *
 * Plain labels, because the audience is not reading variable names. Each entry
 * also carries the direction it reads and a longer explanation used on hover,
 * so the map says what a colour means rather than leaving the reader to infer
 * it. "Darker = higher" holds for every entry, without exception: an earlier
 * version asked "where is rent cheapest?" and painted the most expensive areas
 * darkest, which is the opposite of what the question implies.
 */
export const MAP_METRICS: MapMetric[] = [
  {
    key: 'median_rent_burden_pct',
    label: 'Rent burden',
    unit: 'percent',
    betterWhen: 'lower',
    blurb:
      'Rent as a share of household income, as published. Darker means households spend a larger share of what they earn on rent.',
  },
  {
    key: 'median_gross_rent',
    label: 'Median gross rent',
    unit: 'usd_monthly',
    betterWhen: 'lower',
    blurb:
      'Median monthly gross rent. Darker means higher rent. "Gross" includes taxes, insurance and fees.',
  },
  {
    key: 'price_to_income',
    label: 'Home price vs income',
    unit: 'ratio',
    betterWhen: 'lower',
    blurb:
      'Median home value divided by median household income. Darker means a home costs more relative to what people earn. 4x means a typical home costs four times the typical income.',
    derive: (m) => {
      if (!canDerive(m)) return null
      const price = m.median_home_value
      const income = m.median_household_income
      if (price === null || price === undefined || income === null || income === undefined) return null
      if (income <= 0) return null
      return price / income
    },
  },
  {
    key: 'median_home_value',
    label: 'Median home value',
    unit: 'usd',
    betterWhen: 'lower',
    blurb: 'Median home value as published. Darker means a more valuable home.',
  },
  {
    key: 'median_household_income',
    label: 'Median household income',
    unit: 'usd',
    betterWhen: 'higher',
    blurb: 'Median household income as published. Darker means higher income.',
  },
  {
    key: 'rent_to_income',
    label: 'Year of rent vs income',
    unit: 'ratio',
    betterWhen: 'lower',
    blurb:
      'Twelve months of median rent divided by median income. Darker means rent takes more of a year of income. It is a rough comparison, not the published rent burden figure.',
    derive: (m) => {
      if (!canDerive(m)) return null
      const rent = m.median_gross_rent
      const income = m.median_household_income
      if (rent === null || rent === undefined || income === null || income === undefined) return null
      if (income <= 0) return null
      return (rent * 12) / income
    },
  },
  {
    key: 'households',
    label: 'Households',
    unit: 'count',
    betterWhen: 'lower',
    blurb: 'Occupied housing units — households, meaning homes with people living in them, vacant homes excluded. Darker means more households. This measures size, not quality.',
  },
]

export type MapMetricKey = string

export const MIN_HOUSEHOLDS_FOR_DERIVED = 1

/**
 * True when a derived figure may be formed at all.
 *
 * There used to be a floor of 500 households here, on the reasoning that an ACS
 * median over a few dozen households is dominated by a single family. The
 * reasoning was sound and the outcome was not: it greyed out 438 of 1,412 areas
 * on the price-to-income map, and a reader cannot tell "we are withholding this
 * because we do not trust it" from "there is nothing here". Worse, it was the
 * app's own decision presented as a fact about the place.
 *
 * So the figure is now shown wherever it can be computed, and the areas built on
 * a thin sample are marked as such. The uncertainty is visible, the data is
 * loaded, and neither pretends to be the other.
 */
export function canDerive(m: Record<string, number | null | undefined>): boolean {
  const hh = m.households
  return typeof hh === 'number' && Number.isFinite(hh) && hh >= MIN_HOUSEHOLDS_FOR_DERIVED
}

/**
 * Below this many households a derived figure is marked as a small sample.
 *
 * Shown rather than withheld, so the reader can weigh it themselves.
 */
export const THIN_SAMPLE_HOUSEHOLDS = 500

/**
 * Sequential ramp, light to dark, in a single hue: higher values are darker.
 *
 * This was inverted at first and the inversion is worth recording, because it is
 * the kind of thing that looks deliberate and is simply wrong. Darker ink on a
 * pale background reads as MORE, everywhere a reader has seen a map before:
 * population choropleths, weather heatmaps, dark-mode interfaces. A ramp that
 * darkens toward the low end therefore draws the eye to the lowest values and
 * gives the reader the opposite of what they were expecting. The original
 * choice was made so that dark text would stay legible on a light fill, which
 * is a real concern for a labelled choropleth and irrelevant here, because most
 * hexagons carry no label.
 *
 * Every step keeps real chroma, including the palest, so no step can be
 * mistaken for the flat grey used for absent data. That collision is the cost
 * of flipping the ramp and it is why the pale end is a tinted blue rather than
 * the near-white it would otherwise be.
 */
export const RAMP = [
  // The palest step is deliberately not near-white. Widening the ramp to ten
  // pushed it to #eff6ff, which is indistinguishable from the page it sits on:
  // a hexagon holding a real figure for a real ZIP code simply did not appear,
  // and read as missing data. The lightest step must be clearly a colour.
  '#cfe3fb',
  '#dbeafe',
  '#bfdbfe',
  '#93c5fd',
  '#60a5fa',
  '#3b82f6',
  '#2563eb',
  '#1d4ed8',
  '#1e3a8a',
  '#172554',
]

/**
 * Absent data.
 *
 * A flat neutral grey with no blue in it at all, and lighter than every ramp
 * step, so "no figure" cannot be read as "a low figure". It is the only colour
 * on the map that is not in the blue family.
 */
export const NO_DATA_COLOR = '#e7e5e4'
export const NO_DATA_LABEL = 'not yet imported'

export interface Bin {
  /** Inclusive lower bound of the value range this bin covers. */
  from: number
  /** Exclusive upper bound, or null for the open-ended top bin. */
  to: number | null
  color: string
  count: number
}

/** Linearly interpolates a sorted array at a fractional index. */
function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = (sorted.length - 1) * fraction
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  const low = sorted[lo]
  const high = sorted[hi]
  if (low === undefined || high === undefined) return low ?? high ?? Number.NaN
  return low + (high - low) * (at - lo)
}

/**
 * Builds quantile breaks over the values that actually exist.
 *
 * Quantiles rather than equal intervals because housing distributions are
 * heavily skewed: a few ZIPs hold extreme values that would flatten the rest of
 * the country into a single step. Quantiles keep the map readable, and the
 * legend prints the real boundaries so nothing is hidden by the binning.
 */
export function buildBins(values: readonly number[], ramp: readonly string[] = RAMP): Bin[] {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return []

  /*
   * Contiguous bands, which is the whole point of the legend.
   *
   * This was wrong in a way that was invisible until a real figure made it
   * legible. The first band took its lower edge from the minimum and its upper
   * edge from the first quantile, which is *also* the minimum — so the lightest
   * colour was a zero-width band that no value could ever fall into, and the
   * second band inherited the real lower bound. On the map that printed a legend
   * opening "0.2x to 0.2x" followed by "0.2x to 1.7x", which described no real
   * range and left the palest colour unused on the whole map.
   *
   * Every band now runs from one quantile to the next, so the lightest colour is
   * the one in use, the legend's boundaries are the real ones, and every value
   * lands in exactly one band.
   */
  return ramp.map((color, i) => ({
    from: i === 0 ? clean[0]! : quantile(clean, i / ramp.length),
    to: i === ramp.length - 1 ? null : quantile(clean, (i + 1) / ramp.length),
    color,
    count: 0,
  }))
}

/** Finds the bin a value falls in, or null when it has no usable figure. */
export function binFor(bins: readonly Bin[], value: number | null | undefined): Bin | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) return null
  for (const bin of bins) {
    if (value >= bin.from && (bin.to === null || value < bin.to)) return bin
  }
  return null
}

export function formatValue(value: number, unit: string): string {
  if (unit === 'percent') return `${value.toFixed(1)}%`
  if (unit === 'usd_monthly') return `$${Math.round(value).toLocaleString('en-US')}/mo`
  if (unit === 'usd') return `$${Math.round(value).toLocaleString('en-US')}`
  // A multiple, not a percentage. "3.1x" reads correctly as a ratio and cannot
  // be mistaken for three per cent, which matters because the derived figures
  // sit beside percentages on the same screen.
  if (unit === 'ratio') return `${value.toFixed(1)}x`
  return Math.round(value).toLocaleString('en-US')
}
