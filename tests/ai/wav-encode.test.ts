import { describe, expect, it } from 'vitest'
import { encodeWavPcm16, type PcmBufferLike } from '../../src/ui/ai/MicInput'

/**
 * The transcription endpoint takes exactly one batch shape — mono
 * 16-bit PCM WAV at 16/24 kHz — so the encoder's byte layout is
 * pinned here: header fields, mixdown, and clamping.
 */
function fakeBuffer(channels: number[][], sampleRate = 16000): PcmBufferLike {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (c) => Float32Array.from(channels[c] ?? []),
  }
}

describe('encodeWavPcm16', () => {
  it('writes a canonical 44-byte PCM header and mixes channels down to mono', () => {
    const out = encodeWavPcm16(
      fakeBuffer([
        [0.5, -0.5, 1.5, -1.5],
        [0.5, -0.5, 0.5, -0.5],
      ]),
    )
    const view = new DataView(out)
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...new Uint8Array(out.slice(from, to)))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(12, 16)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16) // bits
    expect(ascii(36, 40)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8) // 4 frames x 2 bytes
    // Mixdown: (0.5+0.5)/2 = 0.5 -> 16384 (0.5 * 32767 rounded); the
    // out-of-range pair clamps: (1.5+0.5)/2 = 1.0 -> 32767.
    expect(view.getInt16(44, true)).toBe(16384)
    expect(view.getInt16(46, true)).toBe(-16384)
    expect(view.getInt16(48, true)).toBe(32767)
    expect(view.getInt16(50, true)).toBe(-32768)
  })
})
