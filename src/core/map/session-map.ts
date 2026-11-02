import type { ComposedAnswer } from '../ai/answer'
import { drivingMetricKey, metricLabel } from './result-scale'

/**
 * The Map tab's model (drive item 17 part c, 2026-11-02): the map is
 * the CURRENT session's results, not a detached generic surface.
 *
 * Until this item, the Map tab drew the whole loaded sweep through
 * the generic MapView — a surface with no relationship to the
 * question the reader had just asked, so switching to Map after an
 * answer showed a different dataset than the answer described. The
 * model here is deliberately small and total: a session with a
 * verified answer that names places has a results map (that answer's
 * places, colored by the answer's driving metric — the same
 * derivation the item-13 ResultMap uses, result-scale's
 * drivingMetricKey, so the tab and the card can never disagree about
 * the driving metric); every other session state — no question yet,
 * an answer still in flight, an answer that verified no places — is
 * the empty state, whose copy invites the first question. A new
 * answer replaces the model's content outright, because the model is
 * a pure function of the session's current answer.
 */
export type SessionMapModel =
  | { kind: 'empty' }
  | {
      kind: 'results'
      /** How many of the answer's places the map draws. */
      placeCount: number
      /** The answer's driving metric key, or null when it carries no figures. */
      drivingMetricKey: string | null
      /** The driving metric's reader-facing label, or null with the key. */
      drivingMetricLabel: string | null
    }

export function sessionMapModel(answer: ComposedAnswer | null): SessionMapModel {
  if (!answer || answer.status !== 'verified' || answer.places.length === 0) {
    return { kind: 'empty' }
  }
  const key = drivingMetricKey(answer)
  return {
    kind: 'results',
    placeCount: answer.places.length,
    drivingMetricKey: key,
    drivingMetricLabel: key ? metricLabel(key) : null,
  }
}
