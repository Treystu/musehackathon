/**
 * POST /api/muse/transcribe — same-origin proxy route (Item 12, mic).
 * Shape validation, closed allowlist, audio metering (reservation /
 * settlement scaled to audio size), breaker, hard shutoff at cap —
 * the same proxy discipline as intent/explain. Counts only: the audio
 * and the transcript pass through to the provider / caller and are
 * never stored (Q1). Framework-free handler so hermetic tests call it
 * directly; the onRequestPost export at the bottom is the thin HTTP
 * adapter. (Union hand-merge, Panel B1: this handler is the Entire
 * tree's Item 12 implementation, re-homed onto the CivicScope proxy
 * framework — src/server/muse-proxy + muse-adapter — that the other
 * routes in this tree use; the Entire tree's ./shared module carried
 * the same helper API.)
 */
import { MeterUnavailableError } from '../../../src/core/ai/meter-persistence'
import { preCallGate, mapMeterError, mapProviderError, attemptCall, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'

export type { ProxyDeps } from '../../../src/server/muse-proxy'

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

async function handleTranscribeCore(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
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
  const reservation = await deps.meter.reserve(req.clientId, estCostMicro, estTokens)
  if (!reservation) {
    await deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
  }

  try {
    const audio = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const result = await attemptCall(deps, () =>
      deps.provider.transcribe(
        { audio, mimeType },
        new AbortController().signal,
      ),
    )
    if (
      typeof result?.transcript !== 'string' ||
      typeof result?.confidence !== 'number' ||
      !Number.isFinite(result.confidence) ||
      result.confidence < 0 ||
      result.confidence > 1 ||
      result.transcript.length > MAX_TRANSCRIPT_CHARS
    ) {
      await deps.meter.release(reservation)
      await deps.meter.recordError('provider_down')
      return err(502, 'provider_down', 'provider returned an unusable transcription')
    }
    const tokensOut = Math.ceil(result.transcript.length / CHARS_PER_TOKEN)
    await deps.meter.settle(reservation, req.clientId, estCostMicro, estTokens, tokensOut)
    return {
      status: 200,
      body: { transcript: result.transcript, confidence: result.confidence },
    }
  } catch (e) {
    await deps.meter.release(reservation)
    await deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    await deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}

/**
 * Exported handler: the core above settles against deps.meter, which in
 * the portal deployment is the Durable Object client. A meter that
 * cannot be read or written fails closed here — 503 breaker_open via
 * mapMeterError, and no unmetered provider call is made — instead of
 * surfacing as an unhandled error.
 */
export async function handleTranscribe(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  try {
    return await handleTranscribeCore(req, deps)
  } catch (e) {
    if (e instanceof MeterUnavailableError) return mapMeterError(e)
    throw e
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleTranscribe)
