/**
 * POST /api/muse/transcribe — route SHELL (Item 2; mic is Item 12, LAST).
 * In the allowlist + meter from day one so mic needs no new route later.
 * No provider call, no mic UI ships with this shell (no dead button).
 */
import { preCallGate, err, type ProxyDeps, type ProxyReply } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/transcribe'])
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

export async function handleTranscribe(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  if (typeof body.mimeType !== 'string' || typeof body.audioBytes !== 'number') {
    return err(400, 'shape_invalid', 'transcribe needs mimeType + audioBytes')
  }
  if (body.audioBytes > MAX_AUDIO_BYTES) {
    return err(400, 'shape_invalid', 'audio exceeds ceiling')
  }
  deps.meter.recordError('provider_down')
  return err(503, 'provider_down', 'transcribe shell: mic wiring is item 12')
}
