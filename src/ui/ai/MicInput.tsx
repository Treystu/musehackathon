import { useEffect, useRef, useState } from 'react'
import {
  grantMicConsent,
  hasMicConsent,
  revokeMicConsent,
  type MicStorage,
} from '../../core/ai/mic'
import type { TranscribeResult } from '../../core/ai/provider'
import { HelpTip } from './HelpTip'

/**
 * Audio-transit disclosure. It used to stand on the mic surface at
 * all times; under the explain-nothing rule (owner, 2026-11-02) it
 * lives behind the mic row's help tip and in the first-use consent
 * copy — the two places a reader reaches for it — verbatim. Audio
 * goes to the transcription helper only to become text; it is not
 * stored (Q1 counts only).
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
  /**
   * End-of-utterance signal for the atomic voice flow (owner ruling,
   * 2026-11-02: end of utterance submits — there is no stop/submit
   * click). Resolves when the utterance is over: the browser
   * implementation measures it (speech heard, then a silence gap;
   * a bounded wait when no speech arrives; a hard cap so a session
   * cannot run open-ended). Optional only so bare test doubles stay
   * valid MicRecorders; a recorder serving the live voice path must
   * provide it — createBrowserRecorder does.
   */
  waitForEndOfUtterance?: () => Promise<void>
}

/* End-of-utterance measurement for the browser recorder. The levels
 * are read from an AnalyserNode on the capture stream, polled while
 * recording. Speech at a normal speaking distance sits well above the
 * threshold against ordinary room noise; the silence gap is long
 * enough not to cut a mid-sentence pause, short enough that the
 * submission still feels immediate. The no-speech bound and the cap
 * exist so a forgotten or silent session ends honestly instead of
 * recording forever. */
const UTTERANCE_SPEECH_RMS = 0.02
const UTTERANCE_SILENCE_MS = 1400
const UTTERANCE_NO_SPEECH_MS = 8000
const UTTERANCE_MAX_MS = 60000
const UTTERANCE_POLL_MS = 100

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
    let utteranceWait: {
      promise: Promise<void>
      cancel: () => void
    } | null = null

    /**
     * Arm the end-of-utterance measurement on the live stream. The
     * AudioContext is analysis-only (an AnalyserNode tap); the
     * recording itself is untouched. Where no AudioContext exists the
     * wait resolves on the no-speech bound alone, so the session
     * still ends rather than hanging.
     */
    function armUtteranceWait(activeStream: unknown) {
      let cancelled = false
      let timer: ReturnType<typeof setInterval> | null = null
      let audioCtx: { close?: () => Promise<void> } | null = null
      const promise = new Promise<void>((resolve) => {
        const startedAt = Date.now()
        let heardSpeech = false
        let lastLoudAt = startedAt
        let analyser: { getFloatTimeDomainData(data: Float32Array): void } | null =
          null
        try {
          const Ctor = (
            globalThis as {
              AudioContext?: new () => {
                createMediaStreamSource(stream: unknown): {
                  connect(node: unknown): void
                }
                createAnalyser(): {
                  getFloatTimeDomainData(data: Float32Array): void
                }
                close?: () => Promise<void>
              }
            }
          ).AudioContext
          if (Ctor) {
            const ctx = new Ctor()
            audioCtx = ctx
            const source = ctx.createMediaStreamSource(activeStream)
            analyser = ctx.createAnalyser()
            source.connect(analyser)
          }
        } catch {
          analyser = null
        }
        const samples = new Float32Array(1024)
        timer = setInterval(() => {
          if (cancelled) return
          const now = Date.now()
          if (analyser) {
            analyser.getFloatTimeDomainData(samples)
            let sum = 0
            for (const s of samples) sum += s * s
            const rms = Math.sqrt(sum / samples.length)
            if (rms >= UTTERANCE_SPEECH_RMS) {
              heardSpeech = true
              lastLoudAt = now
            }
          }
          const ended =
            now - startedAt >= UTTERANCE_MAX_MS ||
            (heardSpeech && now - lastLoudAt >= UTTERANCE_SILENCE_MS) ||
            (!heardSpeech && now - startedAt >= UTTERANCE_NO_SPEECH_MS)
          if (ended) {
            if (timer) clearInterval(timer)
            timer = null
            void audioCtx?.close?.().catch(() => undefined)
            resolve()
          }
        }, UTTERANCE_POLL_MS)
      })
      utteranceWait = {
        promise,
        cancel: () => {
          cancelled = true
          if (timer) clearInterval(timer)
          timer = null
          void audioCtx?.close?.().catch(() => undefined)
        },
      }
    }

    return {
      async start() {
        stream = (await nav.mediaDevices!.getUserMedia!({ audio: true })) as typeof stream
        chunks = []
        recorder = new RecorderCtor(stream)
        recorder.ondataavailable = (e: { data: Blob }) => {
          if (e.data && e.data.size > 0) chunks.push(e.data)
        }
        recorder.start()
        armUtteranceWait(stream)
      },
      waitForEndOfUtterance() {
        return utteranceWait?.promise ?? Promise.resolve()
      },
      async stop() {
        const active = recorder
        if (!active) throw new Error('recorder not started')
        utteranceWait?.cancel()
        utteranceWait = null
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

/* ------------------------------------------------------------------ */
/* Recognition: one utterance in, one final transcript out             */
/* ------------------------------------------------------------------ */

/**
 * Handlers for one recognition session. Interim transcripts are
 * display-only — the caller streams them into the question box as
 * they arrive and never submits them. Exactly one terminal handler
 * fires per session: onFinal (a final transcript, possibly empty) or
 * onError (capture or transcription failed). onWorking fires only on
 * the recorder path, between the end of the utterance and the
 * transcript landing.
 */
export interface MicRecognitionHandlers {
  onInterim: (transcript: string) => void
  onFinal: (result: TranscribeResult) => void
  onWorking?: () => void
  onError: () => void
}

/**
 * One atomic voice session (owner ruling, 2026-11-02). start() begins
 * capture — for the recorder path this is also where the browser's
 * microphone permission prompt happens, so it must be called from
 * inside the user's tap (or the consent Allow tap chained from it).
 * The session ends itself at the end of the utterance and hands over
 * the final transcript; there is deliberately no stop-and-submit
 * operation for a reader to click. abort() exists only for internal
 * cleanup (an unmounted surface, a superseded session), never as a
 * rendered control.
 */
export interface MicRecognizer {
  start(handlers: MicRecognitionHandlers): Promise<void>
  abort(): void
}

interface SpeechRecognitionAlternativeLike {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}

interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}

/**
 * Browser speech-recognition implementation, or null where the
 * platform has none. Interim results stream to onInterim; the final
 * result is held until the recognition service ends the session
 * (its own end-of-utterance detection), then handed over exactly
 * once — recognition end IS the submission trigger, so no reader
 * action sits between the last word and the question running.
 */
export function createBrowserSpeechRecognizer(): MicRecognizer | null {
  try {
    const Ctor = (
      globalThis as {
        SpeechRecognition?: new () => SpeechRecognitionLike
        webkitSpeechRecognition?: new () => SpeechRecognitionLike
      }
    ).SpeechRecognition ??
      (globalThis as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition
    if (typeof Ctor !== 'function') return null
    let active: SpeechRecognitionLike | null = null
    return {
      start(handlers) {
        return new Promise<void>((resolveStart, rejectStart) => {
          const recognition = new Ctor()
          active = recognition
          recognition.interimResults = true
          recognition.continuous = false
          recognition.lang = 'en-US'
          let finalTranscript = ''
          let finalConfidence = 0
          let settled = false
          const settleFinal = () => {
            if (settled) return
            settled = true
            active = null
            handlers.onFinal({
              transcript: finalTranscript,
              confidence: finalConfidence,
            })
          }
          const settleError = () => {
            if (settled) return
            settled = true
            active = null
            handlers.onError()
          }
          recognition.onresult = (event) => {
            let interim = ''
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i]!
              const alternative = result[0]!
              if (result.isFinal) {
                finalTranscript += alternative.transcript
                finalConfidence = alternative.confidence
              } else {
                interim += alternative.transcript
              }
            }
            // Interim words are shown, never submitted: the box
            // carries final words first, then the words still
            // being heard, so the reader watches the question form.
            if (interim) handlers.onInterim(finalTranscript + interim)
          }
          recognition.onerror = (event) => {
            // A denied permission (or a service that will not run)
            // is a failure with an honest note. 'no-speech' and
            // 'aborted' are not failures: the session simply ends,
            // and onend settles it as an empty or final transcript.
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
              settleError()
            }
          }
          recognition.onend = () => settleFinal()
          try {
            recognition.start()
            resolveStart()
          } catch (e) {
            active = null
            rejectStart(e instanceof Error ? e : new Error('recognition failed to start'))
          }
        })
      },
      abort() {
        try {
          active?.abort()
        } catch {
          // Already ended; cleanup only.
        }
        active = null
      },
    }
  } catch {
    return null
  }
}

/**
 * Recorder-path recognizer: the fallback for platforms without
 * speech recognition (the recording still goes to the transcription
 * helper, as the consent copy states). It records until the
 * recorder's end-of-utterance signal, then transcribes and hands
 * over the final transcript — the same atomic shape, minus interim
 * words, which a batch transcription cannot produce.
 */
export function createRecorderRecognizer(
  recorder: MicRecorder,
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<TranscribeResult>,
): MicRecognizer {
  let aborted = false
  return {
    async start(handlers) {
      aborted = false
      // A start failure — a denied permission prompt included —
      // propagates to the caller, which ends the flow with the one
      // honest status line; nothing re-asks.
      await recorder.start()
      if (aborted) return
      if (recorder.waitForEndOfUtterance) {
        await recorder.waitForEndOfUtterance()
      }
      if (aborted) return
      handlers.onWorking?.()
      try {
        const { audio, mimeType } = await recorder.stop()
        const result = await transcribe(audio, mimeType)
        if (!aborted) handlers.onFinal(result)
      } catch {
        if (!aborted) handlers.onError()
      }
    },
    abort() {
      aborted = true
    },
  }
}

/**
 * The platform's recognizer: speech recognition where it exists
 * (interim words stream), the recorder path where it does not, and
 * null where neither exists — the surface then says so plainly
 * instead of rendering a dead control.
 */
export function createBrowserRecognizer(
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<TranscribeResult>,
): MicRecognizer | null {
  return (
    createBrowserSpeechRecognizer() ??
    (() => {
      const recorder = createBrowserRecorder()
      return recorder ? createRecorderRecognizer(recorder, transcribe) : null
    })()
  )
}

type Phase = 'idle' | 'listening' | 'working'

/**
 * Mic input (Item 12; atomic submission, Item 16). One voice icon on
 * the Ask surface, an equal main input beside typing (Q2), never the
 * only path: the text form stays fully usable at all times. First use
 * is consent-gated — capture cannot start before consent — and where
 * no recognizer exists the surface says so plainly instead of
 * rendering a dead control.
 *
 * The flow after the tap (owner ruling, 2026-11-02): interim words
 * stream into the question box as they are heard; at the end of the
 * utterance the final transcript is handed to the parent (AskPanel),
 * which submits it through the ordinary Ask path — voice supersedes
 * the Ask button, so no stop, review, or submit click exists in this
 * path. The previous flow's end-of-speech click (a stop button the
 * reader had to choose to submit the audio) and the
 * low-confidence review state behind it (words held in the box with
 * an instruction to press Ask) are both gone; correction happens
 * after submission, in the box and the understood-request controls
 * that already exist.
 *
 * The consent moment remains one continuous flow (owner, 2026-11-02)
 * and is kept with reason: consent is a load-bearing disclosure, not
 * a redundancy. Speak -> the in-app disclosure/consent sheet (first
 * use only) -> Allow starts capture from the same click, so the
 * browser's permission prompt follows immediately -> listening starts
 * on grant. No second click on the voice icon, and neither layer
 * re-asks later: in-app consent persists in its store, and the
 * browser's grant persists per origin.
 */
export function MicInput({
  transcribe,
  onTranscript,
  onInterimTranscript,
  recognizer,
  recorder,
  storage,
}: {
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<TranscribeResult>
  onTranscript: (result: TranscribeResult) => void
  /** Interim words, display-only: streamed into the question box as they are heard. */
  onInterimTranscript?: (transcript: string) => void
  /**
   * Test/port injection for the recognizer. undefined = build the
   * platform recognizer (an injected recorder, when present, is
   * adapted into one); null = no voice capture on this surface.
   */
  recognizer?: MicRecognizer | null
  /** undefined = use the browser recorder if the platform supports it; null = no recorder. */
  recorder?: MicRecorder | null
  storage?: MicStorage
}) {
  const [activeRecognizer] = useState<MicRecognizer | null>(() => {
    if (recognizer !== undefined) return recognizer
    if (recorder !== undefined) {
      // An explicitly supplied recorder (or explicit null) is the
      // mount's chosen capture path, as before this rework.
      return recorder ? createRecorderRecognizer(recorder, transcribe) : null
    }
    return createBrowserRecognizer(transcribe)
  })
  const [consented, setConsented] = useState<boolean>(() => hasMicConsent(storage))
  const [asking, setAsking] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [liveWords, setLiveWords] = useState('')
  const [note, setNote] = useState('')
  /**
   * Session guard: each start bumps the id, and a session's handlers
   * act only while their id is current and unsettled. The recognizer
   * contract already promises exactly one terminal event; this guard
   * is what keeps a late event from a superseded or unmounted session
   * from submitting a second time.
   */
  const sessionRef = useRef(0)
  const recognizerRef = useRef(activeRecognizer)
  recognizerRef.current = activeRecognizer

  useEffect(() => {
    return () => {
      sessionRef.current += 1
      recognizerRef.current?.abort()
    }
  }, [])

  if (activeRecognizer === null) {
    return (
      <section aria-label="Voice input">
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-slate-700">{MIC_UNAVAILABLE_NOTE}</p>
          <HelpTip label="About voice input" align="right">
            <p id="ask-audio-note" role="note">
              {AUDIO_TRANSIT_DISCLOSURE}
            </p>
          </HelpTip>
        </div>
      </section>
    )
  }

  /**
   * Start one atomic session — which is where the browser's own
   * microphone permission prompt happens (inside the recognizer).
   * A start failure — a denied prompt included — ends the flow here
   * with the one honest status line; nothing re-asks.
   */
  async function startSession() {
    const session = ++sessionRef.current
    setNote('')
    setLiveWords('')
    setPhase('listening')
    let settled = false
    const current = () => sessionRef.current === session && !settled
    try {
      await activeRecognizer!.start({
        onInterim: (transcript) => {
          if (!current()) return
          setLiveWords(transcript)
          onInterimTranscript?.(transcript)
        },
        onWorking: () => {
          if (current()) setPhase('working')
        },
        onFinal: (result) => {
          if (!current()) return
          settled = true
          setPhase('idle')
          setLiveWords('')
          onTranscript(result)
        },
        onError: () => {
          if (!current()) return
          settled = true
          setPhase('idle')
          setLiveWords('')
          setNote(MIC_TRANSCRIBE_FAILED_NOTE)
        },
      })
    } catch {
      if (!current()) return
      settled = true
      setPhase('idle')
      setNote(MIC_TRANSCRIBE_FAILED_NOTE)
    }
  }

  function begin() {
    if (!hasMicConsent(storage)) {
      setAsking(true)
      return
    }
    void startSession()
  }

  function allow() {
    grantMicConsent(storage)
    setConsented(true)
    setAsking(false)
    // One continuous consent moment (owner, 2026-11-02): Allow chains
    // straight into capture from inside this click handler, so the
    // browser permission prompt follows in the same user-gesture
    // chain and listening starts on grant. Stored consent means
    // neither layer asks again on later uses: begin() goes straight
    // to startSession.
    void startSession()
  }

  function forget() {
    revokeMicConsent(storage)
    setConsented(false)
    setAsking(false)
    setNote('Voice consent withdrawn. Typing works fully.')
  }

  return (
    <section aria-label="Voice input">
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'idle' && (
          <button
            type="button"
            aria-label="Speak a question"
            title="Speak a question"
            onClick={begin}
            className="btn-secondary inline-flex h-10 w-10 items-center justify-center rounded-full p-0"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" />
              <path d="M17.5 11.5a5.5 5.5 0 0 1-11 0H4.6a7.4 7.4 0 0 0 6.4 7.3v2.2h2v-2.2a7.4 7.4 0 0 0 6.4-7.3h-1.9Z" />
            </svg>
          </button>
        )}
        <HelpTip label="About voice input" align="right">
          <p id="ask-audio-note" role="note">
            {AUDIO_TRANSIT_DISCLOSURE}
          </p>
          {/*
            Withdrawing consent lives with the consent state itself —
            inside this disclosure panel, beside the words that
            describe what consent covers (owner, 2026-11-02). It used
            to sit on the mic row's primary line next to the Speak
            button, reading as a primary action of the row; the grant
            and remember behaviour is unchanged, only its home moved.
          */}
          {consented && phase === 'idle' && !asking && (
            <button type="button" onClick={forget} className="btn-quiet mt-2">
              Forget voice consent
            </button>
          )}
        </HelpTip>
      </div>
      {phase === 'listening' && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
          {liveWords
            ? `Listening: ${liveWords}`
            : 'Listening. Speak now: your words appear in the box as you speak, and your question runs when you finish.'}
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
