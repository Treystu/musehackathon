import { useState } from 'react'
import {
  grantMicConsent,
  hasMicConsent,
  revokeMicConsent,
  type MicStorage,
} from '../../core/ai/mic'
import type { TranscribeResult } from '../../core/ai/provider'

/**
 * Audio-transit disclosure, shown on the mic surface at all times and
 * referenced by the Speak control. Audio goes to the transcription
 * helper only to become text; it is not stored (Q1 counts only).
 */
export const AUDIO_TRANSIT_DISCLOSURE =
  'Speaking sends your voice audio to the transcription helper; the audio is not stored, and the words run as your question right away.'

/** First-use consent copy. No recording can start until this is allowed. */
export const MIC_CONSENT_COPY =
  'Voice input uses your microphone. When you speak, the audio is sent to the transcription helper to turn it into text; the audio is not stored. You can stop voice input or withdraw this consent at any time. Typing always works fully.'

export const MIC_UNAVAILABLE_NOTE =
  'Voice input is not available in this browser. Typing works fully: you can ask in plain language above, or search, filter, and read every figure by hand below.'

export const MIC_TRANSCRIBE_FAILED_NOTE =
  'Speech could not be turned into text right now. Typing works fully: you can ask in plain language above, or use the manual search below.'

export interface RecordedAudio {
  audio: ArrayBuffer
  mimeType: string
}

/**
 * Recording device abstraction. Hermetic tests inject a fake; the
 * browser implementation below is the only one that touches a real
 * device, and it is created only when the platform supports it.
 */
export interface MicRecorder {
  start(): Promise<void>
  stop(): Promise<RecordedAudio>
}

/** Browser MediaRecorder implementation, or null where unsupported. */
export function createBrowserRecorder(): MicRecorder | null {
  try {
    const nav = (
      globalThis as {
        navigator?: {
          mediaDevices?: { getUserMedia?: (c: { audio: boolean }) => Promise<unknown> }
        }
      }
    ).navigator
    const RecorderCtor = (
      globalThis as { MediaRecorder?: new (stream: unknown) => MediaRecorderLike }
    ).MediaRecorder
    if (!nav?.mediaDevices?.getUserMedia || typeof RecorderCtor !== 'function') {
      return null
    }
    let stream: { getTracks(): { stop(): void }[] } | null = null
    let recorder: MediaRecorderLike | null = null
    let chunks: Blob[] = []
    return {
      async start() {
        stream = (await nav.mediaDevices!.getUserMedia!({ audio: true })) as typeof stream
        chunks = []
        recorder = new RecorderCtor(stream)
        recorder.ondataavailable = (e: { data: Blob }) => {
          if (e.data && e.data.size > 0) chunks.push(e.data)
        }
        recorder.start()
      },
      async stop() {
        const active = recorder
        if (!active) throw new Error('recorder not started')
        const done = new Promise<RecordedAudio>((resolve, reject) => {
          active.onstop = () => {
            void (async () => {
              try {
                const type = active.mimeType || 'audio/webm'
                const blob = new Blob(chunks, { type })
                // The transcription endpoint takes mono PCM WAV only;
                // convert the browser's recording before it is sent.
                // A conversion failure falls back to the raw recording,
                // whose rejection upstream is honest rather than silent.
                try {
                  const wav = await convertBlobToWav(blob)
                  resolve({ audio: wav, mimeType: 'audio/wav' })
                } catch {
                  resolve({ audio: await blob.arrayBuffer(), mimeType: type })
                }
              } catch (e) {
                reject(e instanceof Error ? e : new Error('recording failed'))
              }
            })()
          }
        })
        active.stop()
        stream?.getTracks().forEach((t) => t.stop())
        stream = null
        recorder = null
        return done
      },
    }
  } catch {
    return null
  }
}

interface MediaRecorderLike {
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(): void
  stop(): void
}

/**
 * The transcription model (Muse Voice Transcribe) accepts exactly one
 * batch shape: mono 16-bit PCM WAV at 16 or 24 kHz. Browsers record
 * webm/opus or mp4/aac, so the recording is converted before it is
 * sent — decoded and resampled to 16 kHz mono, then written as a WAV.
 * Pure encoder over a minimal buffer shape so hermetic tests can pin
 * the byte layout without a real AudioBuffer.
 */
export interface PcmBufferLike {
  sampleRate: number
  numberOfChannels: number
  getChannelData(channel: number): Float32Array
}

export function encodeWavPcm16(buffer: PcmBufferLike): ArrayBuffer {
  const channels = Math.max(1, buffer.numberOfChannels)
  const frames = buffer.getChannelData(0).length
  const bytesPerSample = 2
  const dataSize = frames * bytesPerSample
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono: channels are mixed down below
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)
  const channelData: Float32Array[] = []
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += channelData[c]![i] ?? 0
    const sample = Math.max(-1, Math.min(1, sum / channels))
    view.setInt16(offset, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true)
    offset += bytesPerSample
  }
  return out
}

interface AudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<PcmBufferLike>
  close?: () => Promise<void>
}

interface OfflineAudioContextLike {
  startRendering(): Promise<PcmBufferLike>
}

/** Decode a recorded blob and re-render it at 16 kHz mono, WAV out. */
export async function convertBlobToWav(blob: Blob): Promise<ArrayBuffer> {
  const raw = await blob.arrayBuffer()
  const Ctor = (
    globalThis as { AudioContext?: new () => AudioContextLike }
  ).AudioContext
  if (!Ctor) throw new Error('no AudioContext')
  const ctx = new Ctor()
  try {
    const decoded = await ctx.decodeAudioData(raw.slice(0) as ArrayBuffer)
    const OfflineCtor = (
      globalThis as {
        OfflineAudioContext?: new (
          channels: number,
          length: number,
          sampleRate: number,
        ) => OfflineAudioContextLike & {
          createBufferSource(): {
            buffer: PcmBufferLike
            connect(dest: unknown): void
            start(): void
          }
          destination: unknown
        }
      }
    ).OfflineAudioContext
    if (!OfflineCtor) return encodeWavPcm16(decoded)
    const targetRate = 16000
    const length = Math.max(1, Math.ceil((decoded.getChannelData(0).length / decoded.sampleRate) * targetRate))
    const offline = new OfflineCtor(1, length, targetRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWavPcm16(rendered)
  } finally {
    await ctx.close?.().catch(() => undefined)
  }
}

type Phase = 'idle' | 'recording' | 'working'

/**
 * Mic input (Item 12). An equal main input beside typing (Q2), never
 * the only path: the text form stays fully usable at all times. First
 * use is consent-gated — the recorder cannot start before consent —
 * and where no recorder exists the surface says so plainly instead of
 * rendering a dead button. A finished transcript is handed to the
 * parent (AskPanel) and takes the ordinary Ask path from there.
 */
export function MicInput({
  transcribe,
  onTranscript,
  recorder,
  storage,
}: {
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<TranscribeResult>
  onTranscript: (result: TranscribeResult) => void
  /** undefined = use the browser recorder if the platform supports it; null = no recorder. */
  recorder?: MicRecorder | null
  storage?: MicStorage
}) {
  const [activeRecorder] = useState<MicRecorder | null>(() =>
    recorder === undefined ? createBrowserRecorder() : recorder,
  )
  const [consented, setConsented] = useState<boolean>(() => hasMicConsent(storage))
  const [asking, setAsking] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [note, setNote] = useState('')

  if (activeRecorder === null) {
    return (
      <section aria-label="Voice input">
        <p id="ask-audio-note" role="note" className="house-audio-disclosure">
          {AUDIO_TRANSIT_DISCLOSURE}
        </p>
        <p className="mt-2 text-sm text-slate-700">{MIC_UNAVAILABLE_NOTE}</p>
      </section>
    )
  }

  async function begin() {
    if (!hasMicConsent(storage)) {
      setAsking(true)
      return
    }
    setNote('')
    try {
      await activeRecorder!.start()
      setPhase('recording')
    } catch {
      setPhase('idle')
      setNote(MIC_TRANSCRIBE_FAILED_NOTE)
    }
  }

  async function finish() {
    setPhase('working')
    try {
      const { audio, mimeType } = await activeRecorder!.stop()
      const result = await transcribe(audio, mimeType)
      setPhase('idle')
      onTranscript(result)
    } catch {
      setPhase('idle')
      setNote(MIC_TRANSCRIBE_FAILED_NOTE)
    }
  }

  function allow() {
    grantMicConsent(storage)
    setConsented(true)
    setAsking(false)
    setNote('Voice input is on. Use "Speak a question" when you are ready.')
  }

  function forget() {
    revokeMicConsent(storage)
    setConsented(false)
    setAsking(false)
    setNote('Voice consent withdrawn. Typing works fully.')
  }

  return (
    <section aria-label="Voice input">
      <p id="ask-audio-note" role="note" className="house-audio-disclosure">
        {AUDIO_TRANSIT_DISCLOSURE}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {phase === 'recording' ? (
          <button type="button" onClick={() => void finish()} className="btn-primary">
            Stop recording
          </button>
        ) : (
          <button
            type="button"
            aria-describedby="ask-audio-note"
            disabled={phase === 'working'}
            onClick={() => void begin()}
            className="btn-secondary"
          >
            Speak a question
          </button>
        )}
        {consented && phase === 'idle' && !asking && (
          <button type="button" onClick={forget} className="btn-quiet">
            Forget voice consent
          </button>
        )}
      </div>
      {phase === 'recording' && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          Listening. Speak now, then choose Stop recording.
        </p>
      )}
      {phase === 'working' && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          Turning speech into text…
        </p>
      )}
      {asking && (
        <div
          role="group"
          aria-label="Microphone consent"
          className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <p className="text-sm text-slate-700">{MIC_CONSENT_COPY}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={allow} className="btn-primary">
              Allow microphone
            </button>
            <button type="button" onClick={() => setAsking(false)} className="btn-secondary">
              Not now
            </button>
          </div>
        </div>
      )}
      {note && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          {note}
        </p>
      )}
    </section>
  )
}
