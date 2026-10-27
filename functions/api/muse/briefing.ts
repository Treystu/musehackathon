/**
 * POST /api/muse/briefing — route SHELL (Item 2).
 * Shape validation + closed taxonomy only; no provider call.
 * Item 10 wires the assembler behind the validator, or cuts it.
 */
import { preCallGate, err, type ProxyDeps, type ProxyReply } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/briefing'])

export async function handleBriefing(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate
  const body = req.body as Record<string, unknown>
  if (typeof body.figureSetId !== 'string') {
    return err(400, 'shape_invalid', 'briefing needs figureSetId')
  }
  deps.meter.recordError('provider_down')
  return err(503, 'provider_down', 'briefing shell: assembler wiring lands in item 10')
}
