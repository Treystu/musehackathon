import { describe, expect, it } from 'vitest'
import {
  createSpeechDriver,
  type SpeechSynthesisLike,
  type SpeechUtteranceLike,
} from '../../src/ui/ai/speech-driver'

/**
 * Speech driver (C10 branch b): a React-free wrapper over the
 * device's speechSynthesis, exercised here with a fake synthesis
 * object -- queue order, stop immediacy, and mute stickiness are
 * driver behaviour, not device behaviour.
 */

function fakeSynthesis() {
  const spoken: SpeechUtteranceLike[] = []
  let cancelCalls = 0
  const synthesis: SpeechSynthesisLike = {
    speak(utterance) {
      spoken.push(utterance)
    },
    cancel() {
      cancelCalls++
    },
  }
  return {
    synthesis,
    spoken,
    cancelCalls: () => cancelCalls,
    texts: () => spoken.map((u) => u.text),
  }
}

function driverWith(fake: ReturnType<typeof fakeSynthesis>) {
  return createSpeechDriver({
    synthesis: fake.synthesis,
    createUtterance: (text) => ({ text }),
    voiceModeActive: true,
  })
}

describe('speech driver queue', () => {
  it('speaks sentences in queue order', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    expect(driver.speak(['First sentence.', 'Second sentence.'])).toBe(true)
    expect(fake.texts()).toEqual(['First sentence.', 'Second sentence.'])
    expect(driver.isSpeaking()).toBe(true)
  })

  it('a new speak replaces the previous queue instead of appending', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    driver.speak(['Provisional answer.'])
    const cancelsBefore = fake.cancelCalls()
    driver.speak(['Refined answer.'])
    expect(fake.cancelCalls()).toBeGreaterThan(cancelsBefore)
    expect(fake.texts()).toEqual(['Provisional answer.', 'Refined answer.'])
    // The replaced queue no longer counts as speaking.
    fake.spoken[1]!.onend?.()
    expect(driver.isSpeaking()).toBe(false)
  })

  it('speaks nothing when voice mode is inactive', () => {
    const fake = fakeSynthesis()
    const driver = createSpeechDriver({
      synthesis: fake.synthesis,
      createUtterance: (text) => ({ text }),
    })
    expect(driver.isVoiceModeActive()).toBe(false)
    expect(driver.speak(['Should not be spoken.'])).toBe(false)
    expect(fake.spoken).toEqual([])
    driver.setVoiceModeActive(true)
    expect(driver.speak(['Now spoken.'])).toBe(true)
  })

  it('speaks nothing for an empty or blank sentence list', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    expect(driver.speak([])).toBe(false)
    expect(driver.speak(['   '])).toBe(false)
    expect(fake.spoken).toEqual([])
  })

  it('reports unavailable when there is no synthesis object', () => {
    const driver = createSpeechDriver({
      synthesis: null,
      createUtterance: (text) => ({ text }),
      voiceModeActive: true,
    })
    expect(driver.isAvailable()).toBe(false)
    expect(driver.speak(['Nothing.'])).toBe(false)
    expect(driver.isSpeaking()).toBe(false)
  })
})

describe('speech driver stop', () => {
  it('stop is immediate: cancel is called and speaking state clears', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    driver.speak(['One.', 'Two.', 'Three.'])
    expect(driver.isSpeaking()).toBe(true)
    driver.stop()
    expect(fake.cancelCalls()).toBeGreaterThan(0)
    expect(driver.isSpeaking()).toBe(false)
  })

  it('leaving voice mode stops speech', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    driver.speak(['In voice mode.'])
    driver.setVoiceModeActive(false)
    expect(driver.isSpeaking()).toBe(false)
    expect(fake.cancelCalls()).toBeGreaterThan(0)
  })
})

describe('speech driver mute (sticky for the session)', () => {
  it('mute stops current speech and suppresses later speak calls', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    driver.speak(['Before mute.'])
    driver.mute()
    expect(driver.isMuted()).toBe(true)
    expect(driver.isSpeaking()).toBe(false)
    // A new answer arriving does not clear the mute.
    expect(driver.speak(['After mute.'])).toBe(false)
    expect(fake.texts()).toEqual(['Before mute.'])
  })

  it('mute persists across voice-mode toggles until unmute is explicit', () => {
    const fake = fakeSynthesis()
    const driver = driverWith(fake)
    driver.mute()
    driver.setVoiceModeActive(false)
    driver.setVoiceModeActive(true)
    expect(driver.isMuted()).toBe(true)
    expect(driver.speak(['Still muted.'])).toBe(false)
    driver.unmute()
    expect(driver.isMuted()).toBe(false)
    expect(driver.speak(['Unmuted.'])).toBe(true)
  })
})
