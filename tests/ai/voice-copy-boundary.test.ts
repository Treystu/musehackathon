import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METHODOLOGY_VOICE_SENTENCE } from '../../src/ui/ai/spoken-answer'

/**
 * Copy boundary pin (C10 branch b): voice-out is the device's speech
 * synthesis, not a Muse model -- the Meta Model API roster
 * (re-verified 2026-11-02) has no text-to-speech model, and its only
 * voice model is speech-to-text. No voice surface may claim or imply
 * the voice itself is Muse. This test greps the new voice modules
 * plus the two surfaces the integration ship touches (the voice UI
 * and Methodology) so a later copy edit cannot quietly cross the
 * boundary. Muse Voice Transcribe -- the speech-to-text model -- is
 * not a violation: naming it for transcription is literally true.
 */

const ROOT = process.cwd()

const FILES_UNDER_PIN = [
  'src/ui/ai/spoken-answer.ts',
  'src/ui/ai/speech-driver.ts',
  'src/ui/ai/MicInput.tsx',
  'src/ui/Methodology.tsx',
]

const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  // A Muse text-to-speech / speech-synthesis model or endpoint.
  /\bMuse\s+(?:text-to-speech|speech synthesis|tts|voice synthesis)\b/i,
  /\b(?:text-to-speech|speech synthesis)\s+(?:by|from|powered by|model)\s+Muse\b/i,
  // The voice itself attributed to Muse.
  /\bvoice\s+(?:is|comes from|provided by|powered by)\s+(?:a\s+)?Muse\b/i,
  /\bMuse\s+voice\s+(?:model|speaks|reads|narrates)\b/i,
  /\bspoken\s+(?:by|with|using)\s+(?:a\s+)?Muse\s+(?:voice|model)\b/i,
  /\bMuse\s+(?:speaks|reads aloud|narrates)\b/i,
  /\baudio\s+(?:generated|synthesized|synthesised)\s+by\s+Muse\b/i,
]

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('voice copy boundary (C10 branch b)', () => {
  it('no voice surface claims or implies the voice is a Muse model', () => {
    for (const path of FILES_UNDER_PIN) {
      const text = read(path)
      for (const pattern of FORBIDDEN_CLAIMS) {
        expect(
          pattern.test(text),
          `${path} matches forbidden voice claim ${String(pattern)}`,
        ).toBe(false)
      }
    }
  })

  it('the branch-(b) Methodology sentence is the pinned draft wording', () => {
    // The integration ship places this sentence verbatim in
    // Methodology, in the same ship as the driver wiring.
    expect(METHODOLOGY_VOICE_SENTENCE).toBe(
      "The intelligence is Muse; the voice is the device's.",
    )
  })

  it('the new voice modules name the device as the speech source', () => {
    const driver = read('src/ui/ai/speech-driver.ts')
    expect(driver).toContain('speechSynthesis')
    expect(driver.toLowerCase()).toContain("device's")
  })
})
