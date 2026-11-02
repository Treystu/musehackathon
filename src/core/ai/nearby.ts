/**
 * "Nearby" mode radii and the comprehensive blend (plan C9).
 *
 * The radii are interpretation radii for research prompts and answer
 * wording — no new geospatial computation is claimed. The research
 * stage evaluates proximity claims against the applicable radii and
 * the answer states which radii produced them.
 *
 * Decision effects (plan C9, exact):
 *   transport: car    -> {driving, walking, bicycling, transit}
 *   transport: no-car -> {walking, bicycling, transit}
 *   no decision       -> all four (the comprehensive default), blended
 * A proximity finding counts as "near" if it is near under ANY
 * applicable mode; per-mode findings are reported in the criterion
 * evidence, and the comprehensive case uses the annex's exact blend
 * template with the mode basis inside the evidence.
 */

export type NearbyMode = 'walking' | 'bicycling' | 'transit' | 'driving'

/** Mode radii as named constants (plan C9). Values are wording, not geometry. */
export const NEARBY_MODE_RADII: Readonly<
  Record<NearbyMode, { label: string; radiusText: string }>
> = {
  walking: { label: 'walking', radiusText: 'about 1 mile' },
  bicycling: { label: 'biking', radiusText: 'about 3 miles' },
  transit: { label: 'a short public transit ride', radiusText: 'a short public transit ride' },
  driving: { label: 'a short drive', radiusText: 'about a 10 minute drive' },
}

/** Every mode a reader could plausibly use — the comprehensive default's set. */
export const ALL_NEARBY_MODES: readonly NearbyMode[] = [
  'walking',
  'bicycling',
  'transit',
  'driving',
]

const NO_CAR_MODES: readonly NearbyMode[] = ['walking', 'bicycling', 'transit']

/**
 * The applicable mode set for a landed transport decision (or its
 * absence). `undefined` / an unrecognized value = the comprehensive
 * default: all four modes.
 */
export function applicableModes(transportDecision: string | undefined | null): NearbyMode[] {
  if (transportDecision === 'no-car') return [...NO_CAR_MODES]
  // 'car' and the unanswered case both evaluate across all four modes;
  // the difference is only in the wording (a landed car decision is
  // stated as the reader's own basis, the default as the blend).
  return [...ALL_NEARBY_MODES]
}

/** Plain-language list of modes, in the order the blend template names them. */
export function modeListText(modes: readonly NearbyMode[]): string {
  const labels = modes.map((mode) => NEARBY_MODE_RADII[mode].label)
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`
}

/**
 * The proximity criterion's research request focus (plan C9: the
 * request gains a focus — the mode set + radii — instead of only the
 * full question text; this is also minor 9's shape for this criterion
 * class). Carried on the research request beside the question text.
 */
export interface ProximityFocus {
  criterionId: string
  modes: NearbyMode[]
  radii: { mode: NearbyMode; radiusText: string }[]
  /** The focus sentence appended to the research query for this criterion. */
  focusText: string
}

export function proximityFocus(
  criterionId: string,
  transportDecision: string | undefined | null,
): ProximityFocus {
  const modes = applicableModes(transportDecision)
  const radii = modes.map((mode) => ({ mode, radiusText: NEARBY_MODE_RADII[mode].radiusText }))
  const focusText =
    `For judging what counts as near, use only these ways of getting there: ` +
    modes
      .map((mode) => `${NEARBY_MODE_RADII[mode].label} (${NEARBY_MODE_RADII[mode].radiusText})`)
      .join('; ') +
    '. Report findings per way of getting there when the sources allow it.'
  return { criterionId, modes, radii, focusText }
}

/** Per-mode findings as the evidence reports them, e.g. "2 within a short drive; 0 within walking distance". */
export interface ModeFinding {
  mode: NearbyMode
  text: string
}

/**
 * The blend sentence for the comprehensive default (plan annex C9,
 * exact template):
 *   "Counted as near if reachable by <applicable mode list>; across
 *    those modes, <per-mode findings sentence>. (Mode basis: <list>.)"
 * The parenthetical is part of the criterion evidence, not a footnote.
 */
export function blendEvidenceText(input: {
  modes: readonly NearbyMode[]
  findings: readonly ModeFinding[]
}): string {
  const findingsSentence =
    input.findings.length > 0
      ? input.findings.map((finding) => finding.text).join('; ')
      : 'no per-mode breakdown was available from the cited sources'
  return (
    `Counted as near if reachable by ${modeListText(input.modes)}; ` +
    `across those modes, ${findingsSentence}. (Mode basis: ${modeListText(input.modes)}.)`
  )
}

/**
 * The evidence sentence when a transport decision HAS landed: the
 * applicable set is the reader's own basis, stated plainly, with the
 * same per-mode findings and the same in-evidence mode basis.
 */
export function decidedEvidenceText(input: {
  decision: 'car' | 'no-car'
  modes: readonly NearbyMode[]
  findings: readonly ModeFinding[]
}): string {
  const findingsSentence =
    input.findings.length > 0
      ? input.findings.map((finding) => finding.text).join('; ')
      : 'no per-mode breakdown was available from the cited sources'
  return (
    `Counted as near if reachable by ${modeListText(input.modes)}; ` +
    `across those modes, ${findingsSentence}. (Mode basis: ${modeListText(input.modes)}.)`
  )
}

/** Research criterion ids whose subject is a place one gets to — the proximity class. */
export const PROXIMITY_CRITERION_IDS: readonly string[] = [
  'coffee',
  'groceries',
  'restaurants',
  'fast_food',
  'amenities',
]

/** Whether a decomposed criterion is a proximity criterion (plan C9 applies to it). */
export function isProximityCriterion(criterionId: string): boolean {
  return PROXIMITY_CRITERION_IDS.includes(criterionId)
}
