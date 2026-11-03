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
 * says so in words instead of printing the same figure twice. The
 * wording counts the places truthfully: "One place in this answer."
 * is only for a literal single place — the closing battery (cluster
 * A, case A3, on be13e7e) measured two places sharing one figure
 * (Tucson + Brownsville, both $300,000) being described by that
 * single-place text (failure mode legend_single_value_wording), so
 * the multi-place single-value case names its own count and the
 * shared figure, which is that place's own figure by reference.
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
  if (withFigure.length === 1) {
    return { ...base, single: true, singleText: 'One place in this answer.' }
  }
  if (highest.figure.value === lowest.figure.value) {
    return {
      ...base,
      single: true,
      singleText: `${withFigure.length} places in this answer share the same ${label.toLowerCase()} — ${formatAnswerFigure(lowest.figure)}.`,
    }
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
 * Which mode an answer renders in — derived from the ACTUAL PLACES in
 * the answer, not from the scope of the question that produced it.
 *
 * Why: the closing battery (cluster B, case B2, on be13e7e) measured
 * the previous rule returning 'national' from the answer's
 * geographyLevel before any check of the places themselves. B2's
 * answer holds exactly one locality (Hilo, HI 96720) yet rendered the
 * country frame with a value circle — failure mode
 * result_map_mode_keyed_to_question_scope, result_map_scope_mismatch
 * 0.98. A local answer does not become national because its question
 * was asked at national scope.
 *
 * The rule, in order (all inputs are the answer's own places):
 * 1. County answers are their own mode before anything else: a county
 *    figure must never be painted onto member ZCTAs.
 * 2. A single place is one area by definition: scoped (choropleth).
 * 3. When the caller supplies centroids (`points`, keyed by place
 *    zcta — ResultMap always loads them before calling), the span is
 *    MEASURED over those places: a longitude span over
 *    NATIONAL_LON_SPAN_DEGREES, or at least NATIONAL_STATE_COUNT
 *    distinct states in the place names, is genuinely dispersed and
 *    renders as national centroid markers; anything at or under the
 *    span threshold is a scoped viewport and renders as a choropleth,
 *    whatever geographyLevel says. Measured anchors: B2 (one place,
 *    span 0) is scoped; B3 (Hilo, HI / Corbin, KY / a Texas place,
 *    span about 71 degrees of longitude) is national; a two-state
 *    metro (Kansas City, span under 0.1 degrees) stays a choropleth,
 *    because the thresholds are span/state-count based, not
 *    state-count alone (spec section 4.5).
 * 4. Only when no span can be measured (fewer than two places have a
 *    centroid in `points`, or `points` was not supplied) does
 *    geographyLevel remain, as a hint for the one case the place
 *    names cannot settle: a set spread over 2–3 states could be one
 *    metro or several regions. A single-state set needs no hint — it
 *    is one scoped area even when the question was national.
 */
export function resultMapMode(
  answer: ComposedAnswer,
  points?: ReadonlyMap<string, { lon: number; lat: number }>,
): ResultMapMode {
  if (answer.geographyLevel === 'county' || answer.places.some((p) => p.memberZctas)) return 'county'
  if (answer.places.length <= 1) return 'choropleth'
  const states = new Set(
    answer.places.map((p) => stateOfPlaceName(p.name)).filter((s): s is string => s !== null),
  )
  if (states.size >= NATIONAL_STATE_COUNT) return 'national'
  let minLon = Infinity
  let maxLon = -Infinity
  let measured = 0
  if (points) {
    for (const place of answer.places) {
      const point = points.get(place.zcta)
      if (!point) continue
      measured += 1
      if (point.lon < minLon) minLon = point.lon
      if (point.lon > maxLon) maxLon = point.lon
    }
  }
  if (measured >= 2) {
    return maxLon - minLon > NATIONAL_LON_SPAN_DEGREES ? 'national' : 'choropleth'
  }
  // No measurable span: a single-state set is scoped on its own
  // evidence; only a 2–3 state set falls back to the level hint.
  if (states.size <= 1) return 'choropleth'
  return answer.geographyLevel === 'national' ? 'national' : 'choropleth'
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
  // One name per PLACE, not per ZIP area (owner live failure,
  // 2026-11-03): the roll listed the screen's rows, so a city with
  // twenty ZIP areas was named twenty times — a ~500-name flood
  // under a several-hundred-place answer. The roll is the map's
  // text equivalent for the places it does not show; a place is
  // named once, in card order, however many of its ZIP areas the
  // answer holds.
  const seen = new Set<string>()
  const names: string[] = []
  for (const place of ordered.slice(RESULT_MAP_PLACE_CAP)) {
    if (seen.has(place.name)) continue
    seen.add(place.name)
    names.push(place.name)
  }
  return names
}

/**
 * How many unique overflow names the "Also in this answer" roll
 * lists before it counts the rest instead. The roll's job is to
 * name the places the map does not show; past this many names the
 * screening table below the card — which names every place — is
 * the list, and the roll states the count (owner live failure,
 * 2026-11-03: an uncapped roll of several hundred names).
 */
export const OVERFLOW_NAME_LIMIT = 50

/** The roll as rendered: the listed names plus the count it stands in for. */
export function overflowPlaceSummary(answer: ComposedAnswer): {
  names: string[]
  furtherCount: number
} {
  const all = overflowPlaceNames(answer)
  return {
    names: all.slice(0, OVERFLOW_NAME_LIMIT),
    furtherCount: Math.max(0, all.length - OVERFLOW_NAME_LIMIT),
  }
}

/**
 * CHART RELEVANCE (owner standing rules, 2026-11-03: a chart shows
 * only when it serves the request, is perfect when shown, and is
 * bespoke to the request — never a static template): whether the
 * in-card result map serves THIS answer. The predicate reads the
 * answer's shape, in code terms:
 *   - a verified answer only (the mount's own condition, restated
 *     so the predicate is whole on its own);
 *   - NOT a research-first candidate answer (researchNamedPlaces
 *     is stamped only on that path): a superlative / intersection
 *     answer is a ranked candidate list — its geography is not the
 *     information, and a choropleth under it decorates the card
 *     while sampling a set the question never screened;
 *   - at least two places: a one-place map is a portrait of a ZIP
 *     area, not information about an area;
 *   - a driving metric the shown places carry figures for: no
 *     metric, no scale, no map.
 * Screen-composed geographic answers — bounded screens, state and
 * national sweeps, county answers, named-geography comparisons —
 * are the class whose spatial distribution IS the content, and
 * they render exactly as before. The Map view is not gated by
 * this predicate: a reader who navigates to the map has asked for
 * geography, which is the relevance signal there (item 18's
 * session-map contract).
 */
export function resultMapRelevant(answer: ComposedAnswer): boolean {
  if (answer.status !== 'verified') return false
  if (answer.researchNamedPlaces !== undefined) return false
  if (answer.places.length < 2) return false
  return drivingMetricKey(answer) !== null
}

/** One chart a terminal render mounts, as the spoken layer names it. */
export interface TerminalChartKind {
  kind: 'map'
  /** The plain-words name speech uses for this chart ("the map"). */
  spokenName: string
  /**
   * The chart's subject in the legend's own plain words: for the
   * metric-colored result map, the driving metric's label,
   * lowercased for mid-sentence use.
   */
  subject: string
}

/**
 * The charts the terminal render mounts for an answer — the single
 * derivation the card and the spoken layer both read (Lane A8), so
 * the set speech references is the set the card renders BY
 * CONSTRUCTION: a chart that did not render is never referenced,
 * and a rendered chart is always referenced. The card mounts its
 * result map on exactly `answer.status === 'verified' &&
 * resultMapRelevant(answer)` (AnswerCard), and resultMapRelevant
 * already requires the verified status, so this derivation is that
 * mount condition restated as data. Today the map is the only chart
 * kind any answer terminal renders; bar/line kinds slot into this
 * list when a terminal render gains one, and speech picks them up
 * without reshaping. The Map TAB is a view, not a chart the answer
 * created, and is never in this set.
 */
export function terminalChartKinds(answer: ComposedAnswer): TerminalChartKind[] {
  if (!resultMapRelevant(answer)) return []
  const key = drivingMetricKey(answer)
  if (!key) return []
  return [{ kind: 'map', spokenName: 'the map', subject: metricLabel(key).toLowerCase() }]
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
