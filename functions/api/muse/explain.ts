/**
 * POST /api/muse/explain — route SHELL (Item 2).
 * Shape validation + closed taxonomy + meter/breaker/shutoff only.
 * No provider call is made here; Item 8 flips this to live wiring
 * (stub provider in tests; live provider is S10, not this session).
 */
import { preCallGate, err, type ProxyDeps, type ProxyReply } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/explain'])

export async function handleExplain(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  if (typeof body.figureSetId !== 'string' || !Array.isArray(body.values)) {
    return err(400, 'shape_invalid', 'explain needs figureSetId + values[]')
  }
  // Shell: validated, meter-visible, but no provider wired yet.
  deps.meter.recordError('provider_down')
  return err(503, 'provider_down', 'explain shell: provider wiring lands in item 8')
}
