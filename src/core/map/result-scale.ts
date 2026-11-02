/**
 * The result map's model: which metric colors the map, what the legend
 * says, which mode an answer renders in, and which figures the map may
 * emit — all derived from the verified answer object alone.
 *
 * FIGURES BY REFERENCE — the hard rule (result-map spec section 4.3).
 * Every value this module hands the component is copied off an
 * AnswerPlace's figures, and every formatted string is produced by the
 * same registry + formatter the AnswerCard uses, so map, card and
 * table cannot disagree. Nothing here recomputes a figure from sweep
 * rows, derives a ratio, or formats a number that is not an
 * AnswerFigure. The unit tests assert this mechanically: the set of
 * numbers the legend / popover model can emit is a subset of the
 * figures on the card.
 */

import type { AnswerFigure, AnswerPlace, ComposedAnswer } from '../ai/answer'
import { METRIC_DEFS_BY_KEY } from '../civicscope-registry'
import { formatMetricNumber } from '../../ui/metric-format'
import { NO_DATA_COLOR, RAMP } from './scale'

/** The map colors at most this many answer places; the rest are named as text. */
export const RESULT_MAP_PLACE_CAP = 25

/** A place set spanning more longitude than this is not one area (spec section 4.5). */
export const NATIONAL_LON_SPAN_DEGREES = 20

/** A place set spread over at least this many states is not one area either. */
export const NATIONAL_STATE_COUNT = 4

export type ResultMapMode = 'choropleth' | 'county' | 'national'

/** Formats a figure value exactly as the AnswerCard does (sweep precision, no percent suffix). */
export function formatAnswerFigure(figure: AnswerFigure): string {
  const unit = METRIC_DEFS_BY_KEY.get(figure.key)?.unit ?? 'number'
  return formatMetricNumber(figure.value, unit, { percentSuffix: false, sweepPrecision: true })
}

/** The registry label for a metric key, falling back to the key itself (the card's rule). */
export function metricLabel(key: string): string {
  return METRIC_DEFS_BY_KEY.get(key)?.label ?? key
}

/**
 * Display order, mirroring AnswerCard.orderedPlaces: with criteria, by
 * the first criterion's deciding figure (ascending for a maximum,
 * descending for a minimum); without criteria the pipeline order
 * stands. Duplicated deliberately — AnswerCard does not export its
 * ordering, and the map must agree with the card about which place
 * leads rather than inventing a second order.
 */
export function orderedResultPlaces(answer: ComposedAnswer): AnswerPlace[] {
  const criterion = answer.criteria[0]
  if (!criterion) return answer.places
  const direction = criterion.bound === 'atMost' ? 1 : -1
  return [...answer.places].sort((a, b) => {
    const av = a.figures.find((f) => f.key === criterion.metricKey)?.value
    const bv = b.figures.find((f) => f.key === criterion.metricKey)?.value
    if (av === undefined && bv === undefined) return 0
    if (av === undefined) return 1
    if (bv === undefined) return -1
    return (av - bv) * direction
  })
}

/** The answer's driving metric: the first criterion's key, else the first place's first figure. */
export function drivingMetricKey(answer: ComposedAnswer): string | null {
  if (answer.criteria[0]) return answer.criteria[0].metricKey
  return answer.places[0]?.figures[0]?.key ?? null
}

/**
 * The metrics the switcher may offer: figure keys present on EVERY
 * shown place (the intersection, so switching never blanks a place
 * that had a figure), ordered with the driving metric first. When the
 * intersection is empty — places sharing no figure key at all — the
 * union is offered instead and places without the selected figure
 * take the no-data treatment, which the model reports per place.
 * Map-only derived metrics are never offered: they are not on the
 * card, so showing them would break figures-by-reference.
 */
export function eligibleMetricKeys(places: readonly AnswerPlace[], drivingKey: string | null): string[] {
  if (places.length === 0) return []
  const [first, ...rest] = places
  let keys = (first?.figures ?? []).map((f) => f.key)
  for (const place of rest) {
    const held = new Set(place.figures.map((f) => f.key))
    keys = keys.filter((k) => held.has(k))
  }
  if (keys.length === 0) {
    const union: string[] = []
    for (const place of places) {
      for (const f of place.figures) if (!union.includes(f.key)) union.push(f.key)
    }
    keys = union
  }
  if (drivingKey && keys.includes(drivingKey)) {
    return [drivingKey, ...keys.filter((k) => k !== drivingKey)]
  }
  return keys
}

/** One place as the map may show it: its figure for one metric, by reference. */
export interface ResultMapPlace {
  /** The answer place's own key (`zcta`, or the synthetic county key for a county place). */
  key: string
  name: string
  zcta: string
  /** The AnswerFigure for the selected metric, or null when the place carries none. */
  figure: AnswerFigure | null
  /** The figure formatted as the card formats it, or null beside a null figure. */
  formatted: string | null
  /** True for a county aggregate place (memberZctas present). */
  isCounty: boolean
  memberZctas: string[]
}

/** Resolves each place's figure for `metricKey` — a lookup, never a computation. */
export function resultMapPlaces(places: readonly AnswerPlace[], metricKey: string): ResultMapPlace[] {
  return places.map((place) => {
    const figure = place.figures.find((f) => f.key === metricKey) ?? null
    return {
      key: place.zcta,
      name: place.name,
      zcta: place.zcta,
      figure,
      formatted: figure ? formatAnswerFigure(figure) : null,
      isCounty: Array.isArray(place.memberZctas),
      memberZctas: place.memberZctas ? [...place.memberZctas] : [],
    }
  })
}

/**
 * Continuous sequential color for a value, interpolated through the
 * shipped RAMP (light to dark, darker = higher, always — the scale.ts
 * invariant). `t` is the value's position between the answer's own
 * minimum and maximum, so the scale is the answer's, never a national
 * one the answer did not claim. A single distinct value sits mid-ramp.
 */
export function colorForValue(value: number, min: number, max: number): string {
  const t = max > min ? (value - min) / (max - min) : 0.5
  const clamped = Math.max(0, Math.min(1, t))
  const at = clamped * (RAMP.length - 1)
  const lo = Math.floor(at)
  const hi = Math.min(RAMP.length - 1, lo + 1)
  const frac = at - lo
  const a = RAMP[lo]!
  const b = RAMP[hi]!
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const mix = (i: number) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * frac)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

/** The CSS gradient for the legend bar: the RAMP stops, light (lowest) to dark (highest). */
export function legendGradientCss(): string {
  return `linear-gradient(to right, ${RAMP.join(', ')})`
}

export interface LegendEnd {
  placeName: string
  value: number
  formatted: string
  /** The full plain-words label, e.g. "Highest median gross rent — $2,340/mo". */
  text: string
}

export interface LegendModel {
  metricKey: string
  metricLabel: string
  /** Null for a single-place (or single-valued) answer: no gradient is claimed. */
  highest: LegendEnd | null
  lowest: LegendEnd | null
  single: boolean
  singleText: string | null
}

/**
 * The legend model. The ends carry the figures themselves — the
 * highest and lowest places' own AnswerFigure values, formatted as
 * the card formats them — not just "darker = higher". With one place,
 * or one distinct value, there is no range to state and the legend
 * says so in words instead of printing the same figure twice.
 */
export function legendModel(places: readonly AnswerPlace[], metricKey: string): LegendModel {
  const label = metricLabel(metricKey)
  const withFigure = places
    .map((place) => ({ place, figure: place.figures.find((f) => f.key === metricKey) }))
    .filter((x): x is { place: AnswerPlace; figure: AnswerFigure } => x.figure !== undefined)
  const base: LegendModel = {
    metricKey,
    metricLabel: label,
    highest: null,
    lowest: null,
    single: false,
    singleText: null,
  }
  if (withFigure.length === 0) return { ...base, single: true, singleText: 'No figure for this measure is in the answer.' }
  const sorted = [...withFigure].sort((a, b) => a.figure.value - b.figure.value)
  const lowest = sorted[0]!
  const highest = sorted[sorted.length - 1]!
  if (withFigure.length === 1 || highest.figure.value === lowest.figure.value) {
    return { ...base, single: true, singleText: 'One place in this answer.' }
  }
  const end = (word: string, x: { place: AnswerPlace; figure: AnswerFigure }): LegendEnd => ({
    placeName: x.place.name,
    value: x.figure.value,
    formatted: formatAnswerFigure(x.figure),
    text: `${word} ${label.toLowerCase()} — ${formatAnswerFigure(x.figure)}`,
  })
  return { ...base, highest: end('Highest', highest), lowest: end('Lowest', lowest) }
}

/**
 * Every number the map layer can emit for an answer + metric, as raw
 * values: the legend ends and every place's selected-metric figure.
 * The figures-by-reference test asserts each one exists, exactly, on
 * the answer's places — a recompute or rounding path added later
 * fails that assertion instead of drifting silently.
 */
export function emittedFigureValues(answer: ComposedAnswer, metricKey: string): number[] {
  const legend = legendModel(answer.places, metricKey)
  const values: number[] = []
  for (const place of resultMapPlaces(answer.places, metricKey)) {
    if (place.figure) values.push(place.figure.value)
  }
  if (legend.highest) values.push(legend.highest.value)
  if (legend.lowest) values.push(legend.lowest.value)
  return values
}

/** The "…, ST" state a place name carries, or null when it names none. */
export function stateOfPlaceName(name: string): string | null {
  const match = /, ([A-Z]{2})$/.exec(name.trim())
  return match ? match[1]! : null
}

/**
 * Which mode an answer renders in.
 *
 * County answers are their own mode before anything else: a county
 * figure must never be painted onto member ZCTAs. National answers
 * (the answer's own level, or a place set that spans more than
 * NATIONAL_LON_SPAN_DEGREES of longitude, or places in at least
 * NATIONAL_STATE_COUNT states) render as centroid markers, not a
 * choropleth — a two-state metro stays a choropleth, because the
 * thresholds are span/state-count based, not state-count alone
 * (spec section 4.5). `points`, when the caller has centroids, is
 * keyed by place zcta.
 */
export function resultMapMode(
  answer: ComposedAnswer,
  points?: ReadonlyMap<string, { lon: number; lat: number }>,
): ResultMapMode {
  if (answer.geographyLevel === 'county' || answer.places.some((p) => p.memberZctas)) return 'county'
  if (answer.geographyLevel === 'national') return 'national'
  const states = new Set(
    answer.places.map((p) => stateOfPlaceName(p.name)).filter((s): s is string => s !== null),
  )
  if (states.size >= NATIONAL_STATE_COUNT) return 'national'
  if (points) {
    let minLon = Infinity
    let maxLon = -Infinity
    for (const place of answer.places) {
      const point = points.get(place.zcta)
      if (!point) continue
      if (point.lon < minLon) minLon = point.lon
      if (point.lon > maxLon) maxLon = point.lon
    }
    if (Number.isFinite(minLon) && maxLon - minLon > NATIONAL_LON_SPAN_DEGREES) return 'national'
  }
  return 'choropleth'
}

/**
 * The screening-coverage line (plan P6 step 5 — a named honesty
 * requirement): whenever the places the screen covered differ from
 * the places the map shows, the card states both. `screenedCount` is
 * the answer's own field (places in scope before criteria narrowed
 * them); the map shows at most RESULT_MAP_PLACE_CAP of the answer's
 * places. Returns null when the two sets coincide, so the line
 * appears exactly when there is a difference to disclose.
 */
export function screeningCoverageLine(answer: ComposedAnswer, shownCount: number): string | null {
  const total = answer.places.length
  const screened = answer.screenedCount
  if (screened === shownCount && total === shownCount) return null
  const screenedPart =
    screened !== total
      ? `The screen covered ${screened.toLocaleString('en-US')} places and ${total.toLocaleString('en-US')} are in the answer; `
      : `The answer holds ${total.toLocaleString('en-US')} places; `
  return `${screenedPart}this map shows ${shownCount.toLocaleString('en-US')} of them.`
}

/** Places beyond the map cap, named as text under the map (spec section 2.3 rule 1). */
export function overflowPlaceNames(answer: ComposedAnswer): string[] {
  const ordered = orderedResultPlaces(answer)
  return ordered.slice(RESULT_MAP_PLACE_CAP).map((p) => p.name)
}

/**
 * The radius for a national-mode area circle: area proportional to
 * value (radius scales with the square root), inside a fixed band so
 * the smallest value still reads as a place and the largest does not
 * swallow its neighbours. The value itself is never encoded anywhere
 * else — the label beside the tap target carries the figure.
 */
export function nationalCircleRadius(value: number, min: number, max: number): number {
  const MIN_R = 5
  const MAX_R = 22
  if (max <= min) return (MIN_R + MAX_R) / 2
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return MIN_R + (MAX_R - MIN_R) * Math.sqrt(t)
}

export { NO_DATA_COLOR }
