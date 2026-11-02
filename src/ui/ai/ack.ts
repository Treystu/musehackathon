/**
 * The conversational frame's acknowledgment line (plan C6 + annex).
 *
 * The opener set is the annex's exact set, rotated by question hash,
 * never repeated twice in a session back-to-back. The research
 * variant carries the folded-in information of the old stacked status
 * lines (research is running; what it will show): "On it — checking
 * the Census figures and looking into <criterion>."
 */

export const ACK_OPENERS: readonly string[] = [
  'Sure thing — let me look into that.',
  'On it — checking that for you.',
  'Let me look into that.',
]

/** Deterministic hash of the question text, for opener rotation. */
export function questionHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/**
 * Pick the ack opener for a question: rotation by question hash, and
 * when that would repeat the previous opener back-to-back, the next
 * opener in the set instead.
 */
export function pickAckOpener(question: string, previousOpener?: string | null): string {
  const start = questionHash(question) % ACK_OPENERS.length
  let opener = ACK_OPENERS[start]!
  if (opener === previousOpener) {
    opener = ACK_OPENERS[(start + 1) % ACK_OPENERS.length]!
  }
  return opener
}

/** The ack's research variant (annex C6): names the researched criterion it is looking into. */
export function researchAck(criterionLabel: string): string {
  return `On it — checking the Census figures and looking into ${criterionLabel.toLowerCase()}.`
}
