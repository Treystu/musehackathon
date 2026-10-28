/**
 * POST /api/muse/explain — same-origin proxy route (Item 8).
 * Shape validation, closed allowlist, meter reservation/settlement,
 * breaker, hard shutoff. The model's prose is validator-gated before it
 * leaves this function; a failed verdict returns a withholding flag, never
 * the failed prose. Counts only; no bodies are stored (Q1).
 */
import type { ExplainRequest } from '../../../src/core/ai/provider'
import { realValidator, type FigureForValidation } from '../../../src/core/ai/validator'
import { preCallGate, mapProviderError, err, type ProxyDeps, type ProxyReply } from './shared'

const ALLOWED_PATHS = new Set(['/api/muse/explain'])
const MAX_VALUES = 24
const MAX_ID_CHARS = 128
const EST_COST_MICRO = 800
const EST_TOKENS = 512
const ACTUAL_COST_MICRO = 800
const ACTUAL_TOKENS_IN = 128
const ACTUAL_TOKENS_OUT = 128

function parseValues(raw: unknown): ExplainRequest['values'] | null {
  if (!Array.isArray(raw)) return null
  const values: ExplainRequest['values'] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const r = item as Record<string, unknown>
    if (typeof r.key !== 'string' || r.key.length === 0) return null
    if (typeof r.value !== 'number' && r.value !== null) return null
    if (typeof r.value === 'number' && !Number.isFinite(r.value)) return null
    if (
      r.marginOfError !== undefined &&
      (typeof r.marginOfError !== 'number' || !Number.isFinite(r.marginOfError))
    ) {
      return null
    }
    values.push({
      key: r.key,
      value: r.value as number | null,
      marginOfError: r.marginOfError as number | undefined,
    })
  }
  return values
}

export async function handleExplain(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate

  const body = req.body as Record<string, unknown>
  if (
    typeof body.figureSetId !== 'string' ||
    body.figureSetId.length === 0 ||
    body.figureSetId.length > MAX_ID_CHARS
  ) {
    return err(400, 'shape_invalid', 'explain needs figureSetId')
  }
  const values = parseValues(body.values)
  if (!values) return err(400, 'shape_invalid', 'explain needs values[]')
  if (values.length > MAX_VALUES) {
    return err(400, 'shape_invalid', 'too many values')
  }

  const reservation = deps.meter.reserve(req.clientId, EST_COST_MICRO, EST_TOKENS)
  if (!reservation) {
    deps.meter.recordError('budget_exhausted')
    return err(429, 'budget_exhausted')
  }

  try {
    const result = await deps.provider.explain(
      { figureSetId: body.figureSetId, values },
      new AbortController().signal,
    )
    deps.meter.settle(
      reservation,
      req.clientId,
      ACTUAL_COST_MICRO,
      ACTUAL_TOKENS_IN,
      ACTUAL_TOKENS_OUT,
    )

    if (typeof result.prose !== 'string') {
      deps.meter.recordError('provider_down')
      return err(502, 'provider_down', 'provider returned no prose')
    }

    const verdict = realValidator.validate(
      result.prose,
      values as FigureForValidation[],
    )
    if (!verdict.pass) {
      // Local withhold diagnostic: count the failure class only.
      deps.meter.recordError(verdict.failure)
      return { status: 200, body: { withheld: true, failure: verdict.failure } }
    }
    return { status: 200, body: { prose: result.prose } }
  } catch (e) {
    deps.meter.release(reservation)
    deps.meter.recordFailure()
    const mapped = mapProviderError(e)
    deps.meter.recordError(String(mapped.body.error))
    return mapped
  }
}
