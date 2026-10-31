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
  'Speaking sends your voice audio to the transcription helper to turn it into text. The audio is not stored; only the words become your question, and you can check and edit them before anything runs.'

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
                const audio = await blob.arrayBuffer()
                resolve({ audio, mimeType: type })
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

type Phase = 'idle' | 'recording' | 'working'

/**
 * Mic input (Item 12). An equal main input beside typing (Q2), never
 * the only path: the text form stays fully usable at all times. First
 * use is consent-gated — the recorder cannot start before consent —
 * and where no recorder exists the surface says so plainly instead of
 * rendering a dead button. A finished transcript is handed to the
 * parent (AskPanel), which lands it in the editable query text /
 * understood-request chips; nothing executes from speech directly.
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
        <p>{MIC_UNAVAILABLE_NOTE}</p>
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
      {phase === 'recording' ? (
        <button type="button" onClick={() => void finish()}>
          Stop recording
        </button>
      ) : (
        <button
          type="button"
          aria-describedby="ask-audio-note"
          disabled={phase === 'working'}
          onClick={() => void begin()}
        >
          Speak a question
        </button>
      )}
      {phase === 'recording' && (
        <p role="status" aria-live="polite">
          Listening. Speak now, then choose Stop recording.
        </p>
      )}
      {phase === 'working' && (
        <p role="status" aria-live="polite">
          Turning speech into text…
        </p>
      )}
      {asking && (
        <div role="group" aria-label="Microphone consent">
          <p>{MIC_CONSENT_COPY}</p>
          <button type="button" onClick={allow}>
            Allow microphone
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            Not now
          </button>
        </div>
      )}
      {consented && phase === 'idle' && !asking && (
        <button type="button" onClick={forget}>
          Forget voice consent
        </button>
      )}
      {note && (
        <p role="status" aria-live="polite">
          {note}
        </p>
      )}
    </section>
  )
}
