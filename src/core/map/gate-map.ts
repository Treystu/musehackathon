/**
 * The geography-gate map model (drug-law specimen cure, 2026-11-04):
 * for a geography-gated answer, the relevant map frames the
 * QUALIFYING GEOGRAPHIES colored by the Census measure — each bound
 * state shaded by its cheapest screened figure on the headline
 * measure, the winner identifiable — per the owner's map-relevance
 * directive ("a map of relaxed drug laws by cost of living"). The
 * specimen's map framed the unbounded national screen instead (the
 * 25 cheapest ZIPs by rent, encoding neither the classification
 * nor any in-state winner).
 *
 * This module is the model's pure core: it reads the answer's own
 * gate record (answer.ts geographyGate — the classification and the
 * per-state standings the bounded screen produced) and derives the
 * shading classes. Nothing is recomputed from rows here: a state
 * the research classified but the screen could not measure carries
 * the unmeasured class, a state classified but outside the bound
 * (the winner-alone bound) carries the classified class, and every
 * other state is outside the frame. The component
 * (ui/map/GateStatesMap.tsx) draws exactly this model.
 */

import type { ComposedAnswer } from '../ai/answer'
import { colorForValue } from './result-scale'

export type GateMapStateClass = 'valued' | 'unmeasured' | 'classified' | 'outside'

export interface GateMapState {
  code: string
  name: string
  stateClass: GateMapStateClass
  /** The state's cheapest screened figure on the headline measure (valued states only). */
  value: number | null
  /** The cheapest screened place's name (valued states only). */
  cheapestPlaceName: string | null
  /** Fill for a valued state (the shipped ramp); null for the class fills. */
  color: string | null
  /** The state the map marks as the winner (see gateMapModel). */
  isWinner: boolean
}

export interface GateMapModel {
  headlineKey: string
  /** Ramp ends over the valued states; null when fewer than one state is valued. */
  min: number | null
  max: number | null
  states: GateMapState[]
  /** The winning state's code: the research's singled-out state, or
   * the state holding the cheapest screened place in the set. */
  winnerCode: string | null
  /** The cheapest screened place in the qualifying set, for the caption. */
  cheapest: { placeName: string; stateName: string; value: number } | null
}

/**
 * Build the gate map model from an answer's gate record, over the
 * full state list the basemap carries (the caller passes the
 * basemap's own state codes/names so every drawn state has a class).
 * Returns null when the answer carries no gate record.
 */
export function gateMapModel(
  answer: ComposedAnswer,
  basemapStates: readonly { code: string; name: string }[],
): GateMapModel | null {
  const gate = answer.geographyGate
  if (!gate) return null
  const standingByCode = new Map(gate.standings.map((s) => [s.code, s]))
  const boundCodes = new Set(gate.boundStates.map((s) => s.code))
  const classifiedCodes = new Set(gate.classifiedStates.map((s) => s.code))
  const valued = gate.standings.filter((s) => s.cheapestRent !== null)
  const min = valued.length > 0 ? Math.min(...valued.map((s) => s.cheapestRent as number)) : null
  const max = valued.length > 0 ? Math.max(...valued.map((s) => s.cheapestRent as number)) : null
  const cheapestStanding =
    valued.length > 0
      ? valued.reduce((a, b) => ((a.cheapestRent as number) <= (b.cheapestRent as number) ? a : b))
      : null
  const winnerCode =
    gate.winnerState?.code ?? (cheapestStanding ? cheapestStanding.code : null)
  const states: GateMapState[] = basemapStates.map((state) => {
    const standing = standingByCode.get(state.code)
    if (standing && standing.cheapestRent !== null) {
      return {
        code: state.code,
        name: state.name,
        stateClass: 'valued',
        value: standing.cheapestRent,
        cheapestPlaceName: standing.cheapestPlaceName,
        color: colorForValue(standing.cheapestRent, min as number, max as number),
        isWinner: state.code === winnerCode,
      }
    }
    if (boundCodes.has(state.code)) {
      // Bound and screened, but no screened row carried the measure.
      return {
        code: state.code,
        name: state.name,
        stateClass: 'unmeasured',
        value: null,
        cheapestPlaceName: null,
        color: null,
        isWinner: state.code === winnerCode,
      }
    }
    if (classifiedCodes.has(state.code)) {
      // Classified by the research but outside the screen's bound
      // (the winner-alone bound): in the classification, not screened.
      return {
        code: state.code,
        name: state.name,
        stateClass: 'classified',
        value: null,
        cheapestPlaceName: null,
        color: null,
        isWinner: false,
      }
    }
    return {
      code: state.code,
      name: state.name,
      stateClass: 'outside',
      value: null,
      cheapestPlaceName: null,
      color: null,
      isWinner: false,
    }
  })
  return {
    headlineKey: gate.headlineKey,
    min,
    max,
    states,
    winnerCode,
    cheapest: cheapestStanding
      ? {
          placeName: cheapestStanding.cheapestPlaceName as string,
          stateName: cheapestStanding.name,
          value: cheapestStanding.cheapestRent as number,
        }
      : null,
  }
}
