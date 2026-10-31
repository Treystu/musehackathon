/**
 * POST /api/muse/transcribe — same-origin proxy route (Item 12, mic).
 * Shape validation, closed allowlist, audio metering (reservation /
 * settlement scaled to audio size), breaker, hard shutoff at cap —
 * the same proxy discipline as intent/explain. Counts only: the audio
 * and the transcript pass through to the provider / caller and are
 * never stored (Q1). Framework-free handler so hermetic tests call it
 * directly; the Pages Function wrapper at port time is a thin adapter.
 */
import { preCallGate, mapProviderError, err, type ProxyDeps, type ProxyReply } from './shared'

export type { ProxyDeps } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/transcribe'])

/** Closed set of audio container types the transcription model accepts. */
const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
])

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024
export const MAX_TRANSCRIPT_CHARS = 2000

/**
 * Audio metering units. Speech codecs for voice queries sit well under
 * 16 KB/s, so bytes give a conservative duration estimate; cost and
 * token counts settle from that estimate plus the returned transcript
 * size, the same estimate-settles pattern the sibling routes use.
 */
const AUDIO_BYTES_PER_SECOND = 16_000
const COST_PER_SECOND_MICRO = 100
const TOKENS_PER_SECOND = 4
const CHARS_PER_TOKEN = 4

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Decoded byte count of a base64 string, computed before decoding. */
function decodedLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor(b64.length / 4) * 3 - padding
}

function decodeBase64(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return null
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export async function handleTranscribe(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>

  if (typeof body.mimeType !== 'string') {
    return err(400, 'shape_invalid', 'transcribe needs mimeType + audioBase64')
  }
  // Container parameters (e.g. ";codecs=opus") are not part of the type.
  const mimeType = (body.mimeType.split(';')[0] as string).trim().toLowerCase()
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return err(400, 'shape_invalid', `audio type not supported: ${mimeType}`)
  }
  if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
    return err(400, 'shape_invalid', 'transcribe needs mimeType + audioBase64')
  }
  if (decodedLength(body.audioBase64) > MAX_AUDIO_BYTES) {
    return err(400, 'shape_invalid', 'audio exceeds ceiling')
  }
  const bytes = decodeBase64(body.audioBase64)
  if (!bytes || bytes.byteLength === 0) {
    return err(400, 'shape_invalid', 'audio is not valid base64')
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return err(400, 'shape_invalid', 'audio exceeds ceiling')
  }

  const estSeconds = Math.max(1, Math.ceil(bytes.byteLength / AUDIO_BYTES_PER_SECOND))
  const estCostMicro = estSeconds * COST_PER_SECOND_MICRO
  const estTokens = estSeconds * TOKENS_PER_SECOND
  const reservation = deps.meter.reserve(req.clientId, estCostMicro, estTokens)
  if (!reservation) {
    deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
  }

  try {
    const audio = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const result = await deps.provider.transcribe(
      { audio, mimeType },
      new AbortController().signal,
    )
    if (
      typeof result?.transcript !== 'string' ||
      typeof result?.confidence !== 'number' ||
      !Number.isFinite(result.confidence) ||
      result.confidence < 0 ||
      result.confidence > 1 ||
      result.transcript.length > MAX_TRANSCRIPT_CHARS
    ) {
      deps.meter.release(reservation)
      deps.meter.recordError('provider_down')
      return err(502, 'provider_down', 'provider returned an unusable transcription')
    }
    const tokensOut = Math.ceil(result.transcript.length / CHARS_PER_TOKEN)
    deps.meter.settle(reservation, req.clientId, estCostMicro, estTokens, tokensOut)
    return {
      status: 200,
      body: { transcript: result.transcript, confidence: result.confidence },
    }
  } catch (e) {
    deps.meter.release(reservation)
    deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}
